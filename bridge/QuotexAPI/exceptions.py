"""Base exceptions for QuotexAPI."""


class QuotexAPIError(Exception):
    """Base exception for all QuotexAPI errors."""

    pass


class AuthenticationError(QuotexAPIError):
    """Raised when authentication fails."""

    pass


class ConnectionError(QuotexAPIError):
    """Raised when connection to Quotex API fails."""

    pass


class InvalidCredentialsError(AuthenticationError):
    """Raised when provided credentials are invalid."""

    pass


class SessionExpiredError(AuthenticationError):
    """Raised when session has expired and needs re-authentication."""

    pass


class InvalidAssetError(QuotexAPIError):
    """Raised when an invalid asset is specified."""

    pass


class TradeError(QuotexAPIError):
    """Raised when a trade operation fails."""

    pass


class InsufficientBalanceError(TradeError):
    """Raised when account has insufficient balance for trade."""

    pass


class InvalidTradeParametersError(TradeError):
    """Raised when trade parameters are invalid."""

    pass


class OrderNotFoundError(TradeError):
    """Raised when an order cannot be found."""

    pass


class TimeoutError(QuotexAPIError):
    """Raised when an operation times out."""

    pass


class WebSocketError(ConnectionError):
    """Raised when WebSocket connection encounters an error."""

    pass


class ReconnectError(ConnectionError):
    """Raised when reconnection attempts fail."""

    pass


class ConfigurationError(QuotexAPIError):
    """Raised when configuration is invalid or missing."""

    pass
