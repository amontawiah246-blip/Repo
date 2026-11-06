"""Authentication service for QuotexAPI using WebSocket messages."""

import asyncio
from typing import Dict, Optional

from ..config import QuotexConfig
from ..exceptions import AuthenticationError, InvalidCredentialsError, SessionExpiredError
from ..models import UserProfile
from .base import BaseService
from .connection import ConnectionService


class AuthService(BaseService):
    """Authentication service using WebSocket messages for login/logout."""

    def __init__(self, config: QuotexConfig, connection: ConnectionService):
        """
        Initialize authentication service.

        Args:
            config: Configuration instance.
            connection: WebSocket connection service.
        """
        super().__init__(config)
        self._connection = connection
        self._ssid: Optional[str] = None
        self._user_profile: Optional[UserProfile] = None
        self._is_authenticated = False

    async def initialize(self) -> None:
        """Initialize the authentication service."""
        await super().initialize()

    async def cleanup(self) -> None:
        """Cleanup authentication service resources."""
        await super().cleanup()

    async def login_with_email(self, email: str, password: str, is_demo: bool = True) -> UserProfile:
        """
        Login with email and password via WebSocket using Socket.IO format.

        Args:
            email: User email.
            password: User password.
            is_demo: Whether to use demo account (default: True).

        Returns:
            UserProfile: User profile information.

        Raises:
            InvalidCredentialsError: If credentials are invalid.
            AuthenticationError: If authentication fails.
        """
        self._validate_initialized()
        self.logger.info(f"Attempting login with email: {email}")

        try:
            # For email/password, Quotex typically requires HTTP login first
            # to get SSID, then use that SSID for WebSocket authorization
            # This is a simplified version - actual implementation may need HTTP step
            
            login_data = {
                "email": email,
                "password": password,
                "isDemo": 1 if is_demo else 0
            }
            
            # Subscribe to login response
            login_future = asyncio.Future()
            
            def handle_login_response(data):
                if not login_future.done():
                    login_future.set_result(data)
            
            self._connection.subscribe("login", handle_login_response)
            
            # Send Socket.IO login event
            await self._connection.send_socketio_event(
                event="login",
                data=login_data,
                expect_response=False
            )
            
            # Wait for login response
            try:
                response = await asyncio.wait_for(login_future, timeout=30.0)
            finally:
                self._connection.unsubscribe("login", handle_login_response)
            
            # Parse response
            if not response or response.get("isSuccessful") == False:
                error = response.get("message", "Login failed") if response else "No response"
                raise InvalidCredentialsError(error)
            
            # Store session data
            self._ssid = response.get("ssid", response.get("session", ""))
            self._user_profile = UserProfile(
                user_id=response.get("user_id", response.get("userId", "")),
                email=email,
                username=response.get("username", response.get("name", email.split("@")[0])),
                demo_balance=response.get("demo_balance", response.get("demoBalance", 10000.0)),
                real_balance=response.get("real_balance", response.get("realBalance", 0.0)),
                active_account="demo" if is_demo else "real",
                currency=response.get("currency", "USD"),
            )
            self._is_authenticated = True

            self.logger.info(f"Successfully logged in: {email}")
            return self._user_profile

        except InvalidCredentialsError:
            self.logger.error("Invalid credentials provided")
            raise
        except Exception as e:
            self.logger.error(f"Login failed: {str(e)}")
            raise AuthenticationError(f"Login failed: {str(e)}") from e

    async def login_with_ssid(self, ssid: str, is_demo: bool = True) -> UserProfile:
        """
        Login with session ID via WebSocket using Socket.IO format.
        
        Sends: 42["authorization",{"session":"<ssid>","isDemo":1,"tournamentId":0}]

        Args:
            ssid: Session ID (SSID token).
            is_demo: Whether to use demo account (default: True).

        Returns:
            UserProfile: User profile information.

        Raises:
            SessionExpiredError: If SSID is expired or invalid.
            AuthenticationError: If authentication fails.
        """
        self._validate_initialized()
        self.logger.info("Attempting login with SSID via Socket.IO")

        try:
            # Send authorization event in Socket.IO format
            # Format: 42["authorization",{"session":"...","isDemo":1,"tournamentId":0}]
            # Use config values for isDemo and tournamentId
            auth_data = {
                "session": ssid,
                "isDemo": 1 if is_demo else 0,
                "tournamentId": self.config.tournament_id
            }
            
            # Subscribe to authorization response before sending
            # Quotex responds with: 42["s_authorization"]
            auth_future = asyncio.Future()
            
            def handle_auth_response(data):
                if not auth_future.done():
                    auth_future.set_result(data)
            
            self._connection.subscribe("s_authorization", handle_auth_response)
            
            # Send Socket.IO authorization event
            await self._connection.send_socketio_event(
                event="authorization",
                data=auth_data,
                expect_response=False
            )
            
            # Wait for authorization response
            try:
                response = await asyncio.wait_for(auth_future, timeout=30.0)
            except asyncio.TimeoutError:
                self.logger.error("Authorization timeout - no response received")
                raise SessionExpiredError(
                    "Authorization timeout. Your SSID may be expired. "
                    "Please get a fresh SSID from your browser (F12 > Application > Cookies > ssid)"
                )
            finally:
                self._connection.unsubscribe("s_authorization", handle_auth_response)
            
            # Parse response
            # Quotex sends: 42["s_authorization"] or 42["s_authorization", {}]
            # If we got here, it means we received the event, which indicates success
            self.logger.debug(f"Authorization response: {response}")
            
            # Check if authorization was successful
            # If response is None or empty dict, it means just the event name was sent (success)
            if response is None or (isinstance(response, dict) and not response):
                # Success - authorization event received
                pass
            elif isinstance(response, dict):
                # Check for error in response
                if response.get("isSuccessful") == False or response.get("error"):
                    error = response.get("message", "SSID login failed")
                    raise SessionExpiredError(error)

            self._ssid = ssid
            
            # Create user profile from response (or defaults if response is None/empty)
            if response and isinstance(response, dict):
                self._user_profile = UserProfile(
                    user_id=response.get("user_id", response.get("userId", "")),
                    email=response.get("email", ""),
                    username=response.get("username", response.get("name", "user")),
                    demo_balance=response.get("demo_balance", response.get("demoBalance", 10000.0)),
                    real_balance=response.get("real_balance", response.get("realBalance", 0.0)),
                    active_account="demo" if is_demo else "real",
                    currency=response.get("currency", "USD"),
                )
            else:
                # Quotex may send just event name with no data - use defaults
                self._user_profile = UserProfile(
                    user_id="",
                    email="",
                    username="user",
                    demo_balance=10000.0,
                    real_balance=0.0,
                    active_account="demo" if is_demo else "real",
                    currency="USD",
                )
            
            self._is_authenticated = True

            self.logger.info(f"Successfully logged in with SSID (demo={is_demo})")
            return self._user_profile

        except SessionExpiredError:
            self.logger.error("Session ID expired or invalid")
            raise
        except Exception as e:
            self.logger.error(f"SSID login failed: {str(e)}")
            raise AuthenticationError(f"SSID login failed: {str(e)}") from e

    async def logout(self) -> None:
        """
        Logout from the Quotex API via WebSocket.

        Raises:
            AuthenticationError: If logout fails.
        """
        self._validate_initialized()

        if not self._is_authenticated:
            self.logger.warning("Already logged out")
            return

        try:
            # Send logout request via WebSocket
            await self._connection.send_request(
                message_type="logout",
                data={},
                timeout=10.0
            )

            self._ssid = None
            self._user_profile = None
            self._is_authenticated = False

            self.logger.info("Successfully logged out")

        except Exception as e:
            self.logger.error(f"Logout failed: {str(e)}")
            raise AuthenticationError(f"Logout failed: {str(e)}") from e

    @property
    def is_authenticated(self) -> bool:
        """Check if user is authenticated."""
        return self._is_authenticated

    @property
    def ssid(self) -> Optional[str]:
        """Get current session ID."""
        return self._ssid

    @property
    def user_profile(self) -> Optional[UserProfile]:
        """Get current user profile."""
        return self._user_profile

    def get_auth_headers(self) -> Dict[str, str]:
        """
        Get authentication headers for API requests.

        Returns:
            Dict[str, str]: Authentication headers.

        Raises:
            AuthenticationError: If not authenticated.
        """
        if not self._is_authenticated or not self._ssid:
            raise AuthenticationError("Not authenticated")

        return {
            "Authorization": f"Bearer {self._ssid}",
            "Content-Type": "application/json",
        }
