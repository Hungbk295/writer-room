"""
Google Service Account Authentication Helper
Provides robust credential loading from environment variables, files, or repo root.
"""

import base64
import json
import os
from pathlib import Path
from google.oauth2 import service_account
from googleapiclient.discovery import build

DEFAULT_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def find_service_account_credentials(scopes=None):
    """
    Locates and returns service account credentials with fallback priority:
    1. GOOGLE_APPLICATION_CREDENTIALS env var (file path)
    2. SERVICE_ACCOUNT_FILE env var (file path)
    3. SERVICE_ACCOUNT_JSON env var (raw JSON string or base64 encoded)
    4. Repo root service_account.json
    5. CWD service_account.json
    """
    if scopes is None:
        scopes = DEFAULT_SCOPES

    # 1. Check SERVICE_ACCOUNT_JSON env var (raw JSON or base64)
    raw_json = os.environ.get("SERVICE_ACCOUNT_JSON")
    if raw_json:
        raw_json = raw_json.strip()
        try:
            if raw_json.startswith("{"):
                info = json.loads(raw_json)
            else:
                info = json.loads(base64.b64decode(raw_json).decode("utf-8"))
            return service_account.Credentials.from_service_account_info(info, scopes=scopes)
        except Exception as e:
            raise ValueError(f"Failed to parse SERVICE_ACCOUNT_JSON environment variable: {e}")

    # 2. Check candidate file paths
    candidates = []
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        candidates.append(os.environ["GOOGLE_APPLICATION_CREDENTIALS"])
    if os.environ.get("SERVICE_ACCOUNT_FILE"):
        candidates.append(os.environ["SERVICE_ACCOUNT_FILE"])

    repo_root = Path(__file__).resolve().parent.parent
    candidates.append(str(repo_root / "service_account.json"))
    candidates.append(str(Path.cwd() / "service_account.json"))

    for path_str in candidates:
        if path_str and os.path.isfile(path_str):
            return service_account.Credentials.from_service_account_file(path_str, scopes=scopes)

    searched_list = "\n  - ".join(candidates)
    raise FileNotFoundError(
        "Google Cloud Service Account credentials not found.\n"
        f"Searched locations:\n  - {searched_list}\n\n"
        "To resolve:\n"
        "  1. Place 'service_account.json' in the repository root directory, OR\n"
        "  2. Set export GOOGLE_APPLICATION_CREDENTIALS='/path/to/service_account.json', OR\n"
        "  3. Set export SERVICE_ACCOUNT_JSON='<json_or_base64_string>'."
    )


def get_sheets_service(scopes=None):
    """Initializes and returns a Google Sheets API v4 service instance."""
    creds = find_service_account_credentials(scopes=scopes)
    return build("sheets", "v4", credentials=creds)
