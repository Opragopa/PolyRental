"""Telegram-only browser login for the customer site."""
import hashlib
import hmac
import os
import re
import secrets
import time
from html import escape
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app import __version__

router = APIRouter()
COOKIE = "polyrental_site_session"
STATE_COOKIE = "polyrental_login_state"
SESSION_SECONDS = 86400


def _serializer():
    secret = os.getenv("SESSION_SECRET", "")
    if len(secret) < 32 or secret in {"change-me-before-deploy", "replace-with-a-long-random-secret"}:
        raise HTTPException(503, "Вход через Telegram ещё не настроен")
    return URLSafeTimedSerializer(secret, salt="polyrental-customer-site-v1")


def _secure():
    return os.getenv("PUBLIC_URL", "").startswith("https://")


def _cookie(response, name, value, max_age):
    response.set_cookie(name, value, max_age=max_age, httponly=True, secure=_secure(), samesite="lax", path="/")


def _origin():
    value = os.getenv("PUBLIC_URL", "").rstrip("/")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise HTTPException(503, "Адрес сайта не настроен")
    return value


def verified_user(data):
    token = os.getenv("BOT_TOKEN", "")
    if not token or not re.fullmatch(r"[0-9]+", data.get("id", "")) or int(data["id"]) <= 0:
        return None
    if not re.fullmatch(r"[0-9]+", data.get("auth_date", "")) or not re.fullmatch(r"[a-f0-9]{64}", data.get("hash", "")):
        return None
    age = time.time() - int(data["auth_date"])
    if age < 0 or age > int(os.getenv("TELEGRAM_AUTH_MAX_AGE", "86400")):
        return None
    check = "\n".join(f"{key}={value}" for key, value in sorted(data.items()) if key != "hash")
    expected = hmac.new(hashlib.sha256(token.encode()).digest(), check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, data["hash"]):
        return None
    return {"id": int(data["id"]), **{key: data[key] for key in ("first_name", "last_name", "username", "photo_url") if key in data}}


def site_user(request: Request):
    raw = request.cookies.get(COOKIE)
    if not raw:
        return None
    try:
        user = _serializer().loads(raw, max_age=SESSION_SECONDS)
    except (BadSignature, SignatureExpired):
        return None
    if not isinstance(user, dict) or type(user.get("id")) is not int or user["id"] <= 0:
        return None
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("origin") != _origin() or "x-telegram-init-data" not in request.headers:
            raise HTTPException(403, "Запрос отклонён")
    return user


@router.get("/")
def site_root():
    return RedirectResponse("/site", status_code=303)


@router.get("/site/login")
def site_login():
    signer = _serializer()
    username = os.getenv("BOT_USERNAME", "").lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_]{5,32}", username):
        raise HTTPException(503, "Вход через Telegram ещё не настроен")
    nonce = secrets.token_urlsafe(32)
    callback = escape(f"{_origin()}/site/auth?state={nonce}", quote=True)
    page = f'''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход — ПолиРентал</title><link rel="stylesheet" href="/miniapp/static/style.css?v={escape(__version__, quote=True)}"><link rel="stylesheet" href="/miniapp/static/design.css?v={escape(__version__, quote=True)}"><script src="/miniapp/static/theme.js?v={escape(__version__, quote=True)}"></script></head><body class="login-page"><div class="login-shell"><header class="login-header"><div class="brand"><span>ПолиРентал</span><span class="app-version">v{escape(__version__)}</span></div></header><main class="login-card"><div class="login-icon" aria-hidden="true">П</div><p class="eyebrow">АРЕНДА ОБОРУДОВАНИЯ</p><h1>Всё для вашей съёмки</h1><p class="login-description">Войдите через Telegram, чтобы выбрать технику, оформить бронь и следить за заявками.</p><div id="login-widget" class="login-widget" data-bot="{escape(username, quote=True)}" data-callback="{callback}"></div><div id="login-fallback" class="login-fallback" role="status" hidden><p>Не удалось загрузить кнопку Telegram. Проверьте подключение к Telegram и попробуйте ещё раз.</p><button id="login-retry" class="button primary" type="button">Повторить загрузку</button></div><script src="/miniapp/static/site-login.js?v={escape(__version__, quote=True)}" defer></script><p class="login-hint">Для входа понадобится аккаунт Telegram</p></main></div></body></html>'''
    response = HTMLResponse(page, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    _cookie(response, STATE_COOKIE, signer.dumps({"state": nonce}), 600)
    return response


@router.get("/site/auth")
def site_auth(request: Request):
    signer = _serializer()
    pairs = list(request.query_params.multi_items())
    params = dict(pairs)
    if len(pairs) != len(params):
        raise HTTPException(403, "Неверный ответ Telegram")
    state = params.pop("state", "")
    try:
        saved = signer.loads(request.cookies.get(STATE_COOKIE, ""), max_age=600)
    except (BadSignature, SignatureExpired):
        raise HTTPException(403, "Сессия входа истекла")
    if not isinstance(saved, dict) or not state or not hmac.compare_digest(state, saved.get("state", "")):
        raise HTTPException(403, "Неверная сессия входа")
    user = verified_user(params)
    if not user:
        raise HTTPException(403, "Не удалось проверить данные Telegram")
    response = RedirectResponse("/site", status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    _cookie(response, COOKIE, signer.dumps(user), SESSION_SECONDS)
    response.delete_cookie(STATE_COOKIE, path="/")
    return response


@router.get("/api/site/session")
def session(request: Request):
    user = site_user(request)
    if not user:
        raise HTTPException(401, "Войдите через Telegram")
    return user


@router.post("/site/logout")
def logout(request: Request):
    if not site_user(request):
        raise HTTPException(401, "Войдите через Telegram")
    response = RedirectResponse("/site/login", status_code=303)
    response.delete_cookie(COOKIE, path="/")
    return response
