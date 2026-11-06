"""WebSocket protocol message definitions for Quotex API."""

from typing import Any, Dict, Optional, Union
from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime


class MessageType(str, Enum):
    """WebSocket message types."""
    
    # Authentication
    LOGIN = "login"
    LOGOUT = "logout"
    AUTH_RESPONSE = "auth_response"
    
    # Account
    GET_BALANCE = "get_balance"
    SWITCH_ACCOUNT = "switch_account"
    BALANCE_UPDATE = "balance_update"
    
    # Trading
    PLACE_TRADE = "place_trade"
    CANCEL_TRADE = "cancel_trade"
    TRADE_RESULT = "trade_result"
    TRADE_UPDATE = "trade_update"
    
    # Instruments
    GET_ASSETS = "get_assets"
    GET_PAYOUT = "get_payout"
    ASSETS_UPDATE = "assets_update"
    PAYOUT_UPDATE = "payout_update"
    
    # Data streams
    SUBSCRIBE_CANDLES = "subscribe_candles"
    UNSUBSCRIBE_CANDLES = "unsubscribe_candles"
    CANDLE_UPDATE = "candle"
    
    SUBSCRIBE_QUOTES = "subscribe_quotes"
    UNSUBSCRIBE_QUOTES = "unsubscribe_quotes"
    QUOTE_UPDATE = "quote"
    
    # Trade history
    GET_OPEN_TRADES = "get_open_trades"
    GET_TRADE_HISTORY = "get_trade_history"
    TRADES_LIST = "trades_list"
    
    # System
    PING = "ping"
    PONG = "pong"
    ERROR = "error"


@dataclass
class WSMessage:
    """Base WebSocket message structure."""
    
    msg: str  # Message type
    request_id: Optional[str] = None
    timestamp: Optional[int] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {"msg": self.msg}
        if self.request_id:
            result["request_id"] = self.request_id
        if self.timestamp:
            result["timestamp"] = self.timestamp
        return result


@dataclass
class LoginRequest(WSMessage):
    """Login request via email/password."""
    
    msg: str = MessageType.LOGIN
    email: str = ""
    password: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result.update({
            "email": self.email,
            "password": self.password
        })
        return result


@dataclass
class SSIDLoginRequest(WSMessage):
    """Login request via SSID token."""
    
    msg: str = MessageType.LOGIN
    ssid: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result["ssid"] = self.ssid
        return result


@dataclass
class AuthResponse(WSMessage):
    """Authentication response from server."""
    
    msg: str = MessageType.AUTH_RESPONSE
    success: bool = False
    user_id: Optional[str] = None
    ssid: Optional[str] = None
    error: Optional[str] = None
    demo_balance: Optional[float] = None
    real_balance: Optional[float] = None


@dataclass
class PlaceTradeRequest(WSMessage):
    """Place a binary options trade."""
    
    msg: str = MessageType.PLACE_TRADE
    asset: str = ""
    direction: str = ""  # "call" or "put"
    amount: float = 0.0
    expiry_time: int = 60  # in seconds
    account_type: str = "demo"  # "demo" or "real"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result.update({
            "asset": self.asset,
            "direction": self.direction,
            "amount": self.amount,
            "expiry_time": self.expiry_time,
            "account_type": self.account_type
        })
        return result


@dataclass
class TradeResultMessage(WSMessage):
    """Trade result notification from server."""
    
    msg: str = MessageType.TRADE_RESULT
    order_id: str = ""
    status: str = ""  # "pending", "open", "closed", "cancelled"
    result: Optional[str] = None  # "win", "loss", "draw"
    profit: Optional[float] = None
    asset: Optional[str] = None
    direction: Optional[str] = None
    amount: Optional[float] = None
    open_time: Optional[int] = None
    close_time: Optional[int] = None
    countdown: Optional[int] = None  # seconds remaining


@dataclass
class CancelTradeRequest(WSMessage):
    """Cancel a pending trade."""
    
    msg: str = MessageType.CANCEL_TRADE
    order_id: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result["order_id"] = self.order_id
        return result


@dataclass
class BalanceRequest(WSMessage):
    """Get account balance."""
    
    msg: str = MessageType.GET_BALANCE
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return super().to_dict()


@dataclass
class BalanceUpdateMessage(WSMessage):
    """Balance update notification."""
    
    msg: str = MessageType.BALANCE_UPDATE
    demo_balance: float = 0.0
    real_balance: float = 0.0
    active_account: str = "demo"  # "demo" or "real"


@dataclass
class SwitchAccountRequest(WSMessage):
    """Switch between demo and real accounts."""
    
    msg: str = MessageType.SWITCH_ACCOUNT
    account_type: str = "demo"  # "demo" or "real"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result["account_type"] = self.account_type
        return result


@dataclass
class GetAssetsRequest(WSMessage):
    """Get available trading assets."""
    
    msg: str = MessageType.GET_ASSETS
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return super().to_dict()


@dataclass
class GetPayoutRequest(WSMessage):
    """Get payout percentage for an asset."""
    
    msg: str = MessageType.GET_PAYOUT
    asset: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result["asset"] = self.asset
        return result


@dataclass
class SubscribeCandlesRequest(WSMessage):
    """Subscribe to candle data stream."""
    
    msg: str = MessageType.SUBSCRIBE_CANDLES
    asset: str = ""
    timeframe: int = 60  # in seconds
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result.update({
            "asset": self.asset,
            "timeframe": self.timeframe
        })
        return result


@dataclass
class CandleUpdateMessage(WSMessage):
    """Real-time candle update."""
    
    msg: str = MessageType.CANDLE_UPDATE
    asset: str = ""
    timeframe: int = 60
    timestamp: int = 0
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    volume: Optional[float] = None


@dataclass
class SubscribeQuotesRequest(WSMessage):
    """Subscribe to real-time quotes."""
    
    msg: str = MessageType.SUBSCRIBE_QUOTES
    asset: str = ""
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result["asset"] = self.asset
        return result


@dataclass
class QuoteUpdateMessage(WSMessage):
    """Real-time quote/tick update."""
    
    msg: str = MessageType.QUOTE_UPDATE
    asset: str = ""
    price: float = 0.0
    timestamp: int = 0


@dataclass
class GetOpenTradesRequest(WSMessage):
    """Get list of currently open trades."""
    
    msg: str = MessageType.GET_OPEN_TRADES
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return super().to_dict()


@dataclass
class GetTradeHistoryRequest(WSMessage):
    """Get trade history."""
    
    msg: str = MessageType.GET_TRADE_HISTORY
    limit: int = 50
    offset: int = 0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = super().to_dict()
        result.update({
            "limit": self.limit,
            "offset": self.offset
        })
        return result


@dataclass
class ErrorMessage(WSMessage):
    """Error message from server."""
    
    msg: str = MessageType.ERROR
    error_code: Optional[str] = None
    error_message: str = ""
    details: Optional[Dict[str, Any]] = None


def parse_message(data: Dict[str, Any]) -> WSMessage:
    """
    Parse raw WebSocket message into appropriate message object.
    
    Args:
        data: Raw message dictionary
        
    Returns:
        Parsed message object
    """
    msg_type = data.get("msg") or data.get("type") or data.get("event")
    
    # Map message types to classes
    # This is a simplified version - you'd expand this based on actual protocol
    if msg_type == MessageType.AUTH_RESPONSE:
        return AuthResponse(**{k: v for k, v in data.items() if k in AuthResponse.__annotations__})
    elif msg_type == MessageType.TRADE_RESULT:
        return TradeResultMessage(**{k: v for k, v in data.items() if k in TradeResultMessage.__annotations__})
    elif msg_type == MessageType.BALANCE_UPDATE:
        return BalanceUpdateMessage(**{k: v for k, v in data.items() if k in BalanceUpdateMessage.__annotations__})
    elif msg_type == MessageType.CANDLE_UPDATE:
        return CandleUpdateMessage(**{k: v for k, v in data.items() if k in CandleUpdateMessage.__annotations__})
    elif msg_type == MessageType.QUOTE_UPDATE:
        return QuoteUpdateMessage(**{k: v for k, v in data.items() if k in QuoteUpdateMessage.__annotations__})
    elif msg_type == MessageType.ERROR:
        return ErrorMessage(**{k: v for k, v in data.items() if k in ErrorMessage.__annotations__})
    else:
        # Generic message
        return WSMessage(msg=msg_type or "unknown", **{k: v for k, v in data.items() if k != "msg"})
