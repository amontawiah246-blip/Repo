"""Service modules for QuotexAPI."""

from .account import AccountService
from .auth import AuthService
from .base import BaseService
from .connection import ConnectionService
from .data import DataService
from .instrument import InstrumentService
from .trading import TradingService

__all__ = [
    "BaseService",
    "AuthService",
    "ConnectionService",
    "AccountService",
    "InstrumentService",
    "TradingService",
    "DataService",
]
