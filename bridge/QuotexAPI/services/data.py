"""Data service for managing trade history, live trades, and real-time data via WebSocket."""

import asyncio
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any, Callable

from ..config import QuotexConfig
from ..enums import TradeResult, TradeStatus
from ..exceptions import OrderNotFoundError, QuotexAPIError, TimeoutError
from ..models import Trade, Candle
from .base import BaseService
from .connection import ConnectionService


class DataService(BaseService):
    """Service for managing trade data, history, and real-time data streams via WebSocket."""

    def __init__(self, config: QuotexConfig, connection: ConnectionService):
        """
        Initialize data service.

        Args:
            config: Configuration instance.
            connection: WebSocket connection service.
        """
        super().__init__(config)
        self._connection = connection
        self._active_trades: dict[str, Trade] = {}
        self._candle_subscribers: Dict[str, List[Callable]] = {}
        self._quote_subscribers: Dict[str, List[Callable]] = {}

    async def initialize(self) -> None:
        """Initialize the data service and subscribe to WebSocket events."""
        await super().initialize()
        
        # Subscribe to Quotex real-time data events
        # Quotex sends candle/depth updates as "depth" events
        self._connection.subscribe("depth", self._handle_candle_update)
        self._connection.subscribe("depth", self._handle_quote_update)
        
        # Also handle tick data if available
        self._connection.subscribe("tick", self._handle_quote_update)

    async def get_open_trades(self) -> List[Trade]:
        """
        Get list of open (active) trades via WebSocket.

        Returns:
            List[Trade]: List of open trades.

        Raises:
            QuotexAPIError: If fetching fails.
        """
        self._validate_initialized()
        self.logger.info("Fetching open trades")

        try:
            # Request open trades via WebSocket
            response = await self._connection.send_request(
                message_type="get_open_trades",
                data={},
                timeout=10.0
            )
            
            if not response or not response.get("success"):
                raise QuotexAPIError("Failed to fetch open trades")
            
            # Parse trades from response
            trades_data = response.get("trades", [])
            open_trades = [
                Trade(
                    order_id=t.get("order_id", ""),
                    asset=t.get("asset", ""),
                    direction=t.get("direction", "call"),
                    amount=t.get("amount", 0.0),
                    expiry=t.get("expiry", 60),
                    status=TradeStatus.ACTIVE,
                    result=None,
                    profit=None,
                    open_price=t.get("open_price", 0.0),
                    close_price=None,
                    open_time=datetime.fromtimestamp(t.get("open_time", 0)),
                    close_time=None,
                    payout_percentage=t.get("payout", 0.0),
                )
                for t in trades_data
            ]

            self._active_trades = {trade.order_id: trade for trade in open_trades}

            self.logger.info(f"Found {len(open_trades)} open trades")
            return open_trades

        except Exception as e:
            self.logger.error(f"Failed to fetch open trades: {str(e)}")
            raise QuotexAPIError(f"Failed to fetch open trades: {str(e)}") from e
    
    async def subscribe_candles(self, asset: str, timeframe: int = 60) -> None:
        """
        Subscribe to real-time candle data stream via WebSocket.
        
        Quotex format: 42["depth/follow","EURNZD_otc"]
        
        Args:
            asset: Asset symbol (e.g., "EURUSD")
            timeframe: Candle timeframe in seconds (default: 60) - note: Quotex depth/follow doesn't specify timeframe in subscription
        """
        self._validate_initialized()
        
        # Format asset name (add _otc suffix if not present)
        formatted_asset = asset if asset.endswith("_otc") else f"{asset}_otc"
        
        self.logger.info(f"Subscribing to candles: {formatted_asset}")
        
        # Send Socket.IO depth/follow event
        await self._connection.send_socketio_event(
            event="depth/follow",
            data=formatted_asset,  # Just the asset string, not a dict
            expect_response=False
        )
    
    async def unsubscribe_candles(self, asset: str, timeframe: int = 60) -> None:
        """
        Unsubscribe from candle data stream.
        
        Quotex format: 42["depth/unfollow","EURNZD_otc"]
        
        Args:
            asset: Asset symbol
            timeframe: Candle timeframe in seconds (ignored for Quotex)
        """
        self._validate_initialized()
        
        # Format asset name (add _otc suffix if not present)
        formatted_asset = asset if asset.endswith("_otc") else f"{asset}_otc"
        
        self.logger.info(f"Unsubscribing from candles: {formatted_asset}")
        
        # Send Socket.IO depth/unfollow event
        await self._connection.send_socketio_event(
            event="depth/unfollow",
            data=formatted_asset,  # Just the asset string
            expect_response=False
        )
    
    async def subscribe_quotes(self, asset: str) -> None:
        """
        Subscribe to real-time quote/tick data via WebSocket.
        
        Args:
            asset: Asset symbol (e.g., "EURUSD")
        """
        self._validate_initialized()
        
        # Format asset name (add _otc suffix if not present)
        formatted_asset = asset if asset.endswith("_otc") else f"{asset}_otc"
        
        self.logger.info(f"Subscribing to quotes: {formatted_asset}")
        
        # Quotex uses same depth/follow for quotes
        await self._connection.send_socketio_event(
            event="depth/follow",
            data=formatted_asset,
            expect_response=False
        )
    
    def on_candle(self, asset: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        """
        Register callback for candle updates.
        
        Args:
            asset: Asset to monitor
            callback: Function to call on candle update
        """
        if asset not in self._candle_subscribers:
            self._candle_subscribers[asset] = []
        self._candle_subscribers[asset].append(callback)
    
    def on_quote(self, asset: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        """
        Register callback for quote updates.
        
        Args:
            asset: Asset to monitor
            callback: Function to call on quote update
        """
        if asset not in self._quote_subscribers:
            self._quote_subscribers[asset] = []
        self._quote_subscribers[asset].append(callback)
    
    async def _handle_candle_update(self, data: Dict[str, Any]) -> None:
        """Handle incoming candle update from WebSocket."""
        asset = data.get("asset")
        if not asset:
            return
        
        if asset in self._candle_subscribers:
            for callback in self._candle_subscribers[asset]:
                try:
                    if asyncio.iscoroutinefunction(callback):
                        await callback(data)
                    else:
                        callback(data)
                except Exception as e:
                    self.logger.error(f"Candle callback error: {e}")
    
    async def _handle_quote_update(self, data: Dict[str, Any]) -> None:
        """Handle incoming quote update from WebSocket."""
        asset = data.get("asset")
        if not asset:
            return
        
        if asset in self._quote_subscribers:
            for callback in self._quote_subscribers[asset]:
                try:
                    if asyncio.iscoroutinefunction(callback):
                        await callback(data)
                    else:
                        callback(data)
                except Exception as e:
                    self.logger.error(f"Quote callback error: {e}")

    async def get_trade_history(
        self,
        limit: int = 50,
        offset: int = 0,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> List[Trade]:
        """
        Get trade history.

        Args:
            limit: Maximum number of trades to return.
            offset: Offset for pagination.
            start_date: Filter by start date.
            end_date: Filter by end date.

        Returns:
            List[Trade]: List of historical trades.

        Raises:
            QuotexAPIError: If fetching fails.
        """
        self._validate_initialized()
        self.logger.info(f"Fetching trade history (limit: {limit}, offset: {offset})")

        try:
            # TODO: Implement actual API call
            # This is a placeholder implementation
            await asyncio.sleep(0.1)  # Simulate API call

            # Mock historical trades
            history = [
                Trade(
                    order_id="hist1",
                    asset="BTCUSD",
                    direction="put",
                    amount=20.0,
                    expiry=300,
                    status=TradeStatus.COMPLETED,
                    result=TradeResult.WIN,
                    profit=18.0,
                    open_price=43500.0,
                    close_price=43450.0,
                    open_time=datetime.now() - timedelta(hours=2),
                    close_time=datetime.now() - timedelta(hours=2) + timedelta(seconds=300),
                    payout_percentage=90.0,
                ),
                Trade(
                    order_id="hist2",
                    asset="EURUSD",
                    direction="call",
                    amount=15.0,
                    expiry=300,
                    status=TradeStatus.COMPLETED,
                    result=TradeResult.LOSS,
                    profit=-15.0,
                    open_price=1.0850,
                    close_price=1.0840,
                    open_time=datetime.now() - timedelta(hours=1),
                    close_time=datetime.now() - timedelta(hours=1) + timedelta(seconds=300),
                    payout_percentage=85.0,
                ),
            ]

            # Apply filters
            filtered = history
            if start_date:
                filtered = [t for t in filtered if t.open_time >= start_date]
            if end_date:
                filtered = [t for t in filtered if t.open_time <= end_date]

            # Apply pagination
            paginated = filtered[offset : offset + limit]

            self.logger.info(f"Fetched {len(paginated)} historical trades")
            return paginated

        except Exception as e:
            self.logger.error(f"Failed to fetch trade history: {str(e)}")
            raise QuotexAPIError(f"Failed to fetch trade history: {str(e)}") from e

    async def track_trade_result(
        self, order_id: str, callback: Optional[callable] = None
    ) -> Trade:
        """
        Asynchronously track trade by order ID with countdown and final result.

        Args:
            order_id: Order ID to track.
            callback: Optional callback function called with updates.

        Returns:
            Trade: Completed trade with final result.

        Raises:
            OrderNotFoundError: If order not found.
            QuotexAPIError: If tracking fails.
        """
        self._validate_initialized()
        self.logger.info(f"Starting to track trade: {order_id}")

        try:
            # TODO: Implement actual tracking via WebSocket or polling
            # This is a placeholder implementation
            trade = await self._get_trade_by_id(order_id)

            if trade.status == TradeStatus.COMPLETED:
                self.logger.info(f"Trade {order_id} already completed")
                return trade

            # Calculate time remaining
            elapsed = (datetime.now() - trade.open_time).total_seconds()
            remaining = max(0, trade.expiry - elapsed)

            self.logger.info(f"Trade {order_id} has {remaining}s remaining")

            # Simulate countdown
            while remaining > 0:
                await asyncio.sleep(1)
                remaining -= 1

                if callback:
                    await callback(order_id, remaining, trade)

            # Simulate final result
            await asyncio.sleep(0.1)
            trade.status = TradeStatus.COMPLETED
            trade.result = TradeResult.WIN  # Mock result
            trade.close_price = 1.0865
            trade.close_time = datetime.now()
            trade.profit = trade.amount * (trade.payout_percentage / 100)

            self.logger.info(
                f"Trade {order_id} completed: {trade.result.value} "
                f"(profit: {trade.profit})"
            )

            if callback:
                await callback(order_id, 0, trade)

            return trade

        except OrderNotFoundError:
            raise
        except Exception as e:
            self.logger.error(f"Failed to track trade: {str(e)}")
            raise QuotexAPIError(f"Failed to track trade: {str(e)}") from e

    async def wait_for_result(
        self, order_id: str, timeout: Optional[float] = None
    ) -> Trade:
        """
        Blocking wait for trade result.

        Args:
            order_id: Order ID to wait for.
            timeout: Maximum time to wait in seconds.

        Returns:
            Trade: Completed trade with result.

        Raises:
            OrderNotFoundError: If order not found.
            TimeoutError: If timeout is reached.
            QuotexAPIError: If waiting fails.
        """
        self._validate_initialized()
        self.logger.info(f"Waiting for trade result: {order_id}")

        try:
            if timeout:
                result = await asyncio.wait_for(
                    self.track_trade_result(order_id), timeout=timeout
                )
            else:
                result = await self.track_trade_result(order_id)

            return result

        except asyncio.TimeoutError:
            self.logger.error(f"Timeout waiting for trade {order_id}")
            raise TimeoutError(f"Timeout waiting for trade result: {order_id}")
        except Exception as e:
            self.logger.error(f"Failed waiting for result: {str(e)}")
            raise

    async def _get_trade_by_id(self, order_id: str) -> Trade:
        """
        Get trade by order ID.

        Args:
            order_id: Order ID.

        Returns:
            Trade: Trade information.

        Raises:
            OrderNotFoundError: If order not found.
        """
        # Check active trades
        if order_id in self._active_trades:
            return self._active_trades[order_id]

        # TODO: Fetch from API if not in cache
        await asyncio.sleep(0.05)

        # Mock trade if not found
        raise OrderNotFoundError(f"Order not found: {order_id}")
