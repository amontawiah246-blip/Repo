"""Trading service for placing and managing trades via WebSocket."""

import asyncio
import uuid
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, Callable

from ..config import QuotexConfig
from ..enums import TradeDirection, TradeStatus
from ..exceptions import InsufficientBalanceError, InvalidTradeParametersError, TradeError
from ..models import Trade, TradeRequest
from .base import BaseService
from .connection import ConnectionService


class TradingService(BaseService):
    """Service for placing and managing trades via WebSocket messages."""

    def __init__(self, config: QuotexConfig, connection: ConnectionService):
        """
        Initialize trading service.

        Args:
            config: Configuration instance.
            connection: WebSocket connection service.
        """
        super().__init__(config)
        self._connection = connection
        self._trade_callbacks: Dict[str, Callable] = {}

    async def initialize(self) -> None:
        """Initialize the trading service and subscribe to trade updates."""
        await super().initialize()
        
        # Subscribe to trade result updates
        self._connection.subscribe("trade_result", self._handle_trade_update)
        self._connection.subscribe("trade_update", self._handle_trade_update)

    async def place_trade(self, trade_request: TradeRequest, is_demo: bool = True) -> Trade:
        """
        Place a binary options trade (CALL/PUT) via WebSocket.
        
        Quotex format: 42["orders/open",{"asset":"CHFJPY_otc","amount":1,"time":60,"action":"call","isDemo":1,"tournamentId":0,"requestId":1764266241,"optionType":100}]

        Args:
            trade_request: Trade request parameters.
            is_demo: Whether to use demo account (default: True).

        Returns:
            Trade: Placed trade information.

        Raises:
            InvalidTradeParametersError: If trade parameters are invalid.
            InsufficientBalanceError: If account balance is insufficient.
            TradeError: If placing trade fails.
        """
        self._validate_initialized()
        self.logger.info(
            f"Placing trade: {trade_request.asset} "
            f"{trade_request.direction.value.upper()} "
            f"{trade_request.amount} USD "
            f"({trade_request.expiry}s)"
        )

        try:
            # Validate trade parameters
            await self._validate_trade_request(trade_request)

            # Generate request ID
            import time
            request_id = int(time.time() * 1000)  # Unix timestamp in milliseconds
            
            # Format asset name (remove _otc suffix if present, Quotex might add it)
            asset = trade_request.asset.replace("_otc", "")
            
            # Prepare order data in Quotex format
            order_data = {
                "asset": asset,
                "amount": int(trade_request.amount),  # Quotex expects integer
                "time": trade_request.expiry,
                "action": trade_request.direction.value.lower(),  # "call" or "put"
                "isDemo": 1 if is_demo else 0,
                "tournamentId": 0,
                "requestId": request_id,
                "optionType": 100  # Binary option type
            }
            
            self.logger.info(f"Sending order: {order_data}")
            
            # Subscribe to ACK response
            order_future = asyncio.Future()
            
            def handle_ack_response(data):
                self.logger.info(f"Received ACK response: {data}")
                if not order_future.done():
                    order_future.set_result(data)
            
            # Subscribe to the generic ACK response event
            self._connection.subscribe("_ack_response", handle_ack_response)
            
            # Also subscribe to possible direct event responses
            self._connection.subscribe("orders/open", handle_ack_response)
            self._connection.subscribe("order/created", handle_ack_response)
            
            # Send Socket.IO order open event
            await self._connection.send_socketio_event(
                event="orders/open",
                data=order_data,
                expect_response=False
            )
            
            # Wait for response
            try:
                response = await asyncio.wait_for(order_future, timeout=30.0)
            finally:
                self._connection.unsubscribe("_ack_response", handle_ack_response)
                self._connection.unsubscribe("orders/open", handle_ack_response)
                self._connection.unsubscribe("order/created", handle_ack_response)
            
            # Parse response
            if not response:
                raise TradeError("No response received from server")
            
            self.logger.info(f"Trade response: {response}")
            
            # Check for errors in response
            if isinstance(response, dict):
                # Check various error fields
                if response.get("error") or response.get("isSuccessful") == False:
                    error = response.get("message") or response.get("error") or "Trade placement failed"
                    raise TradeError(error)
            
            # Parse response into Trade object
            now = datetime.now()
            
            # Parse the Quotex response format
            if isinstance(response, dict):
                order_id = str(response.get("id", request_id))
                open_price = float(response.get("openPrice", 0.0))
                close_price = float(response.get("closePrice", 0.0)) if response.get("closePrice") else None
                payout = float(response.get("percentProfit", 85.0))
                profit = float(response.get("profit", 0.0))
                
                # Parse status based on closePrice
                if close_price and close_price > 0:
                    # Trade already closed (shouldn't happen)
                    status = TradeStatus.WIN if profit > 0 else TradeStatus.LOSS
                else:
                    status = TradeStatus.ACTIVE
            else:
                order_id = str(request_id)
                open_price = 0.0
                close_price = None
                payout = 85.0
                profit = 0.0
                status = TradeStatus.ACTIVE
            
            trade = Trade(
                order_id=order_id,
                asset=trade_request.asset,
                direction=trade_request.direction,
                amount=trade_request.amount,
                expiry=trade_request.expiry,
                status=status,
                result=None if status == TradeStatus.ACTIVE else ("win" if profit > 0 else "loss"),
                profit=profit if profit != 0.0 else None,
                open_price=open_price,
                close_price=close_price,
                open_time=now,
                close_time=None if status == TradeStatus.ACTIVE else now + timedelta(seconds=trade_request.expiry),
                payout_percentage=payout,
            )

            self.logger.info(f"Trade placed successfully: {trade.order_id} (requestId: {request_id})")
            return trade

        except (InvalidTradeParametersError, InsufficientBalanceError):
            raise
        except Exception as e:
            self.logger.error(f"Failed to place trade: {str(e)}")
            raise TradeError(f"Failed to place trade: {str(e)}") from e

    async def cancel_trade(self, order_id: str) -> bool:
        """
        Cancel trade before it starts (if supported) via WebSocket.

        Args:
            order_id: Order ID to cancel.

        Returns:
            bool: True if cancelled successfully.

        Raises:
            TradeError: If cancellation fails.
        """
        self._validate_initialized()
        self.logger.info(f"Attempting to cancel trade: {order_id}")

        try:
            # Send cancel request via WebSocket
            response = await self._connection.send_request(
                message_type="cancel_trade",
                data={"order_id": order_id},
                timeout=10.0
            )
            
            if not response or not response.get("success"):
                error = response.get("error", "Cancellation failed") if response else "No response"
                raise TradeError(error)

            self.logger.info(f"Trade cancelled: {order_id}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to cancel trade: {str(e)}")
            raise TradeError(f"Failed to cancel trade: {str(e)}") from e
    
    def on_trade_update(self, order_id: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        """
        Subscribe to updates for a specific trade.
        
        Args:
            order_id: Order ID to monitor
            callback: Callback function to receive trade updates
        """
        self._trade_callbacks[order_id] = callback
        self.logger.debug(f"Subscribed to updates for trade: {order_id}")
    
    async def _handle_trade_update(self, data: Dict[str, Any]) -> None:
        """
        Handle incoming trade update messages.
        
        Args:
            data: Trade update data from WebSocket
        """
        order_id = data.get("order_id")
        if not order_id:
            return
        
        self.logger.debug(f"Trade update received for {order_id}: {data}")
        
        # Call registered callback if exists
        if order_id in self._trade_callbacks:
            try:
                callback = self._trade_callbacks[order_id]
                if asyncio.iscoroutinefunction(callback):
                    await callback(data)
                else:
                    callback(data)
                
                # Remove callback if trade is closed
                if data.get("status") in ["closed", "cancelled"]:
                    del self._trade_callbacks[order_id]
            except Exception as e:
                self.logger.error(f"Trade callback error: {e}")

    async def _validate_trade_request(self, request: TradeRequest) -> None:
        """
        Validate trade request parameters.

        Args:
            request: Trade request to validate.

        Raises:
            InvalidTradeParametersError: If parameters are invalid.
            InsufficientBalanceError: If balance is insufficient.
        """
        # Validate amount
        if request.amount < 1.0:
            raise InvalidTradeParametersError("Minimum trade amount is 1 USD")

        if request.amount > 10000.0:
            raise InvalidTradeParametersError("Maximum trade amount is 10,000 USD")

        # Validate expiry
        if request.expiry < 60:
            raise InvalidTradeParametersError("Minimum expiry is 60 seconds")

        if request.expiry > 3600:
            raise InvalidTradeParametersError("Maximum expiry is 3600 seconds")

        # TODO: Check balance (would need reference to account service)
        # For now, just do a simple check
        mock_balance = 1000.0
        if request.amount > mock_balance:
            raise InsufficientBalanceError(
                f"Insufficient balance. Available: {mock_balance}, Required: {request.amount}"
            )
