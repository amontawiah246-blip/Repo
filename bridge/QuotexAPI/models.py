"""Data models for QuotexAPI."""

from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field, field_validator

from .enums import AccountType, AssetType, TradeDirection, TradeResult, TradeStatus


class Asset(BaseModel):
    """Asset information model."""

    symbol: str = Field(..., description="Asset symbol/identifier")
    name: str = Field(..., description="Asset display name")
    asset_type: AssetType = Field(..., description="Type of asset")
    is_active: bool = Field(default=True, description="Whether asset is available for trading")
    current_payout: Optional[float] = Field(
        None, ge=0, le=100, description="Current payout percentage"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "symbol": "EURUSD",
                "name": "EUR/USD",
                "asset_type": "forex",
                "is_active": True,
                "current_payout": 85.5,
            }
        }


class Balance(BaseModel):
    """Account balance model."""

    account_type: AccountType = Field(..., description="Type of account")
    amount: float = Field(..., ge=0, description="Current balance amount")
    currency: str = Field(default="USD", description="Currency code")
    is_active: bool = Field(default=False, description="Whether this is the active account")

    class Config:
        json_schema_extra = {
            "example": {
                "account_type": "demo",
                "amount": 10000.0,
                "currency": "USD",
                "is_active": True,
            }
        }


class TradeRequest(BaseModel):
    """Trade request model."""

    asset: str = Field(..., description="Asset symbol to trade")
    direction: TradeDirection = Field(..., description="Trade direction (CALL/PUT)")
    amount: float = Field(..., gt=0, description="Trade amount")
    expiry: int = Field(..., gt=0, description="Trade expiry time in seconds")

    @field_validator("expiry")
    @classmethod
    def validate_expiry(cls, v: int) -> int:
        """Validate expiry time."""
        if v < 60:
            raise ValueError("Expiry must be at least 60 seconds")
        return v

    class Config:
        json_schema_extra = {
            "example": {
                "asset": "EURUSD",
                "direction": "call",
                "amount": 10.0,
                "expiry": 300,
            }
        }


class Trade(BaseModel):
    """Trade information model."""

    order_id: str = Field(..., description="Unique order identifier")
    asset: str = Field(..., description="Asset symbol")
    direction: TradeDirection = Field(..., description="Trade direction")
    amount: float = Field(..., description="Trade amount")
    expiry: int = Field(..., description="Expiry time in seconds")
    status: TradeStatus = Field(..., description="Current trade status")
    result: Optional[TradeResult] = Field(None, description="Trade result")
    profit: Optional[float] = Field(None, description="Profit/loss amount")
    open_price: Optional[float] = Field(None, description="Price when trade was opened")
    close_price: Optional[float] = Field(None, description="Price when trade was closed")
    open_time: datetime = Field(..., description="Time when trade was opened")
    close_time: Optional[datetime] = Field(None, description="Time when trade was closed")
    payout_percentage: Optional[float] = Field(None, description="Payout percentage")

    class Config:
        json_schema_extra = {
            "example": {
                "order_id": "abc123",
                "asset": "EURUSD",
                "direction": "call",
                "amount": 10.0,
                "expiry": 300,
                "status": "active",
                "result": None,
                "profit": None,
                "open_price": 1.0850,
                "close_price": None,
                "open_time": "2025-11-27T10:30:00Z",
                "close_time": None,
                "payout_percentage": 85.5,
            }
        }


class TradeResult(BaseModel):
    """Trade result model."""

    order_id: str = Field(..., description="Order identifier")
    result: TradeResult = Field(..., description="Trade outcome")
    profit: float = Field(..., description="Profit/loss amount")
    close_price: float = Field(..., description="Closing price")
    close_time: datetime = Field(..., description="Time when trade closed")

    class Config:
        json_schema_extra = {
            "example": {
                "order_id": "abc123",
                "result": "win",
                "profit": 8.55,
                "close_price": 1.0865,
                "close_time": "2025-11-27T10:35:00Z",
            }
        }


class Candle(BaseModel):
    """Candle/OHLC data model."""

    asset: str = Field(..., description="Asset symbol")
    timestamp: int = Field(..., description="Candle timestamp (Unix time)")
    open: float = Field(..., description="Opening price")
    high: float = Field(..., description="Highest price")
    low: float = Field(..., description="Lowest price")
    close: float = Field(..., description="Closing price")
    volume: Optional[float] = Field(None, description="Trading volume")
    timeframe: Optional[int] = Field(None, description="Timeframe in seconds")

    class Config:
        json_schema_extra = {
            "example": {
                "asset": "EURUSD_otc",
                "timestamp": 1732704000,
                "open": 1.0850,
                "high": 1.0865,
                "low": 1.0845,
                "close": 1.0860,
                "volume": 1000.0,
                "timeframe": 60,
            }
        }


class UserProfile(BaseModel):
    """User profile model."""

    user_id: Optional[str] = Field(None, description="User identifier")
    email: Optional[str] = Field(None, description="User email")
    username: Optional[str] = Field(None, description="Username")
    demo_balance: Optional[float] = Field(None, description="Demo account balance")
    real_balance: Optional[float] = Field(None, description="Real account balance")
    active_account: AccountType = Field(..., description="Currently active account type")
    currency: str = Field(default="USD", description="Account currency")

    class Config:
        json_schema_extra = {
            "example": {
                "user_id": "user123",
                "email": "user@example.com",
                "username": "trader",
                "demo_balance": 10000.0,
                "real_balance": 500.0,
                "active_account": "demo",
                "currency": "USD",
            }
        }


class ConnectionConfig(BaseModel):
    """Connection configuration model."""

    api_url: str = Field(default="https://api.quotex.io", description="API base URL")
    ws_url: str = Field(default="wss://ws.quotex.io", description="WebSocket URL")
    reconnect_enabled: bool = Field(default=True, description="Enable auto-reconnect")
    max_reconnect_attempts: int = Field(default=5, ge=0, description="Max reconnection attempts")
    reconnect_delay: float = Field(default=5.0, ge=0, description="Delay between reconnects")
    request_timeout: float = Field(default=30.0, gt=0, description="Request timeout in seconds")

    class Config:
        json_schema_extra = {
            "example": {
                "api_url": "https://api.quotex.io",
                "ws_url": "wss://ws.quotex.io",
                "reconnect_enabled": True,
                "max_reconnect_attempts": 5,
                "reconnect_delay": 5.0,
                "request_timeout": 30.0,
            }
        }
