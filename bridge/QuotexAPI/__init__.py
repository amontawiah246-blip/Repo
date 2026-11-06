"""
QuotexAPI - Unofficial Python API for Quotex broker.

This package provides a comprehensive interface for interacting with the Quotex
trading platform, including authentication, trading, data retrieval, and account management.

Example:
    >>> from QuotexAPI import QuotexAPI, TradeDirection, AccountType
    >>> 
    >>> async def main():
    ...     api = QuotexAPI(email="user@example.com", password="password")
    ...     
    ...     # Connect and authenticate
    ...     profile = await api.connect()
    ...     print(f"Connected as: {profile.email}")
    ...     
    ...     # Check balance
    ...     balance = await api.get_balance()
    ...     print(f"Balance: {balance.amount} {balance.currency}")
    ...     
    ...     # Get available assets
    ...     assets = await api.get_assets()
    ...     print(f"Available assets: {len(assets)}")
    ...     
    ...     # Place a trade
    ...     trade = await api.buy(
    ...         asset="EURUSD",
    ...         amount=10.0,
    ...         direction=TradeDirection.CALL,
    ...         expiry=300
    ...     )
    ...     print(f"Trade placed: {trade.order_id}")
    ...     
    ...     # Wait for result
    ...     result = await api.wait_for_result(trade.order_id)
    ...     print(f"Result: {result.result}, Profit: {result.profit}")
    ...     
    ...     # Disconnect
    ...     await api.disconnect()
"""

from .client import QuotexAPI
from .config import QuotexConfig, load_config
from .enums import (
    AccountType,
    AssetType,
    ConnectionState,
    TradeDirection,
    TradeResult,
    TradeStatus,
)
from .exceptions import (
    AuthenticationError,
    ConnectionError,
    InsufficientBalanceError,
    InvalidAssetError,
    InvalidCredentialsError,
    InvalidTradeParametersError,
    OrderNotFoundError,
    QuotexAPIError,
    ReconnectError,
    SessionExpiredError,
    TimeoutError,
    TradeError,
    WebSocketError,
)
from .models import Asset, Balance, Candle, Trade, TradeRequest, UserProfile

__version__ = "0.1.0"
__author__ = "ChipaDevTeam"
__all__ = [
    # Main client
    "QuotexAPI",
    # Configuration
    "QuotexConfig",
    "load_config",
    # Enums
    "AccountType",
    "AssetType",
    "ConnectionState",
    "TradeDirection",
    "TradeResult",
    "TradeStatus",
    # Exceptions
    "QuotexAPIError",
    "AuthenticationError",
    "ConnectionError",
    "InvalidCredentialsError",
    "SessionExpiredError",
    "InvalidAssetError",
    "TradeError",
    "InsufficientBalanceError",
    "InvalidTradeParametersError",
    "OrderNotFoundError",
    "TimeoutError",
    "WebSocketError",
    "ReconnectError",
    # Models
    "Asset",
    "Balance",
    "Candle",
    "Trade",
    "TradeRequest",
    "UserProfile",
]
