"""Base service class for QuotexAPI services."""

import logging
from abc import ABC
from typing import Any, Dict, Optional

from ..config import QuotexConfig
from ..utils.logger import get_logger


class BaseService(ABC):
    """Base class for all QuotexAPI services."""

    def __init__(self, config: QuotexConfig, logger: Optional[logging.Logger] = None):
        """
        Initialize base service.

        Args:
            config: Configuration instance.
            logger: Logger instance. If None, creates a new logger.
        """
        self.config = config
        self.logger = logger or get_logger(self.__class__.__name__)
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the service. Override in subclasses if needed."""
        self._initialized = True
        self.logger.debug(f"{self.__class__.__name__} initialized")

    async def cleanup(self) -> None:
        """Cleanup service resources. Override in subclasses if needed."""
        self._initialized = False
        self.logger.debug(f"{self.__class__.__name__} cleaned up")

    def _validate_initialized(self) -> None:
        """Validate that service is initialized."""
        if not self._initialized:
            raise RuntimeError(f"{self.__class__.__name__} not initialized")
