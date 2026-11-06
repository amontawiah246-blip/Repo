"""Enumerations for QuotexAPI."""

from enum import Enum


class AccountType(str, Enum):
    """Account type enumeration."""

    DEMO = "demo"
    REAL = "real"


class TradeDirection(str, Enum):
    """Trade direction enumeration."""

    CALL = "call"
    PUT = "put"


class TradeStatus(str, Enum):
    """Trade status enumeration."""

    PENDING = "pending"
    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class TradeResult(str, Enum):
    """Trade result enumeration."""

    WIN = "win"
    LOSS = "loss"
    DRAW = "draw"
    PENDING = "pending"


class ConnectionState(str, Enum):
    """Connection state enumeration."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    FAILED = "failed"


class AssetType(str, Enum):
    """Asset type enumeration."""

    FOREX = "forex"
    CRYPTO = "crypto"
    COMMODITIES = "commodities"
    INDICES = "indices"
    STOCKS = "stocks"
