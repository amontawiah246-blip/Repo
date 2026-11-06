"""Logging utilities for QuotexAPI."""

import logging
import sys
from typing import Optional


def setup_logger(
    name: str = "quotex_api",
    level: str = "INFO",
    format_string: Optional[str] = None,
) -> logging.Logger:
    """
    Set up logger for QuotexAPI.

    Args:
        name: Logger name.
        level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        format_string: Custom format string for log messages.

    Returns:
        logging.Logger: Configured logger instance.
    """
    logger = logging.getLogger(name)

    # Avoid adding handlers multiple times
    if logger.handlers:
        return logger

    logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Create console handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Create formatter
    if format_string is None:
        format_string = (
            "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
        )

    formatter = logging.Formatter(format_string)
    handler.setFormatter(formatter)

    # Add handler to logger
    logger.addHandler(handler)

    return logger


def get_logger(name: str = "quotex_api") -> logging.Logger:
    """
    Get logger instance.

    Args:
        name: Logger name.

    Returns:
        logging.Logger: Logger instance.
    """
    return logging.getLogger(name)
