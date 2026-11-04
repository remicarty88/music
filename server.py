"""Бэкенд для «Тон»: оборачивает yandex-music-api в простой JSON API.

Локальный запуск:
    pip install -r requirements.txt
    export YANDEX_MUSIC_TOKEN="ваш_токен"
    python server.py

На Railway запускается через gunicorn (см. Procfile / railway.json).
Переменные окружения: YANDEX_MUSIC_TOKEN, BOT_TOKEN, ALLOWED_USER_IDS.
"""
import hashlib
import hmac
import json
import os
import threading
import time
from urllib.parse import parse_qsl

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException
from yandex_music import Client



def load_token():
    """Токен берём из переменной окружения или из файла token.txt рядом с server.py."""
    t = os.getenv("YANDEX_MUSIC_TOKEN", "").strip()
    if not t and os.path.exists("token.txt"):
        with open("token.txt", encoding="utf-8") as f:
            t = f.read().strip()
    return t.strip("\"' ") or None


# Прокси для запросов к Яндекс Музыке. Нужен, когда сервер стоит за границей:
# Яндекс отдаёт 451 (Unavailable For Legal Reasons) на IP датацентров, например Railway.
# Формат: http://user:pass@host:port или socks5://host:port
PROXY = os.getenv("YANDEX_MUSIC_PROXY", "").strip() or None


def make_client(token=None):
    c = Client(token).init() if token else Client().init()
    if PROXY:
        c.request.proxies = {"http": PROXY, "https": PROXY}  # requests
        c.request.proxy_url = PROXY  # aiohttp
        print("[ton] запросы к Яндекс Музыке идут через прокси")
    return c


TOKEN = load_token()
TOKEN_ERROR = None
if TOKEN:
    try:
        client = make_client(TOKEN)
        print("[ton] токен принят, вход выполнен")
    except Exception as e:  # неверный или просроченный токен
        TOKEN_ERROR = str(e)
        print(f"[ton] ТОКЕН НЕ ПРИНЯТ: {e}. Работаем без авторизации (будут отрывки по 30 секунд).")
        TOKEN = None
        client = make_client()
else:
    print("[ton] токен не найден (ни YANDEX_MUSIC_TOKEN, ни token.txt). Будут отрывки по 30 секунд.")
    client = make_client()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(BASE_DIR, "static"), static_url_path="")

# ---------- Доступ только из вашего Telegram Mini App ----------
# Сервер хранит ваш токен Яндекса, поэтому без проверки любой, кто узнает адрес,
# мог бы слушать музыку и ставить лайки от вашего имени.
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ALLOWED_IDS = {x.strip() for x in os.getenv("ALLOWED_USER_IDS", "").split(",") if x.strip()}
ON_RAILWAY = bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"))
ALLOW_PUBLIC = os.getenv("ALLOW_PUBLIC") == "1"
if not BOT_TOKEN:
    print("[ton] ВНИМАНИЕ: BOT_TOKEN не задан — проверка Telegram отключена."
          + (" На Railway API будет закрыт, пока вы его не зададите." if ON_RAILWAY and not ALLOW_PUBLIC else ""))


def verify_init_data(raw, max_age=86400):
    """Проверяет подпись Telegram.WebApp.initData. Возвращает dict пользователя или None."""
    try:
        pairs = dict(parse_qsl(raw, keep_blank_values=True, strict_parsing=True))
    except ValueError:
        return None
    got_hash = pairs.pop("hash", None)
    if not got_hash:
        return None
    check = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, got_hash):
        return None
    try:
        if time.time() - int(pairs.get("auth_date", "0")) > max_age:
            return None
        return json.loads(pairs.get("user", "{}"))
    except ValueError:
        return None


@app.before_request
def guard_api():
    if not request.path.startswith("/api/"):
        return None
    if not BOT_TOKEN:
        if ON_RAILWAY and not ALLOW_PUBLIC:
            return jsonify({"error": "Сервер не настроен: задайте переменную BOT_TOKEN."}), 503
        return None
    user = verify_init_data(request.headers.get("X-Tg-Init-Data", ""))
    if user is None:
        return jsonify({"error": "Откройте приложение из Telegram."}), 401
    if ALLOWED_IDS and str(user.get("id")) not in ALLOWED_IDS:
        return jsonify({"error": "Нет доступа к этому приложению."}), 403
    g.tg_user = user
    return None


@app.after_request
def no_stale_assets(resp):
    # Telegram агрессивно кэширует веб-вью; HTML/JS/CSS всегда проверяем заново.
    if not request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/healthz")
def healthz():
    return "ok"


def cover_url(uri, size="400x400"):
    return f"https://{uri.replace('%%', size)}" if uri else None


def track_dto(t):
    album_id = t.albums[0].id if t.albums else None
    return {
        "id": f"{t.id}:{album_id}" if album_id else str(t.id),
        "title": t.title,
        "artists": ", ".join(a.name for a in t.artists),
        # Для кликабельных исполнителей: id и имя каждого артиста отдельно.
        "artist_list": [{"id": str(a.id), "name": a.name} for a in t.artists if a.id],
        "album": (
            {"id": str(t.albums[0].id), "title": t.albums[0].title}
            if t.albums else None
        ),
        "duration": (t.duration_ms or 0) // 1000,
        "cover": cover_url(t.cover_uri),
    }


def album_dto(a):
    return {
        "id": str(a.id),
        "title": a.title,
        "year": a.year or (a.release_date or "")[:4] or None,
        "type": getattr(a, "type", None),
        "artists": ", ".join(x.name for x in (a.artists or [])),
        "artist_list": [{"id": str(x.id), "name": x.name} for x in (a.artists or []) if x.id],
        "track_count": a.track_count,
        "cover": cover_url(a.cover_uri),
    }


def artist_dto(a):
    cover = getattr(a, "cover", None)
    uri = getattr(cover, "uri", None) or getattr(a, "og_image", None)
    counts = getattr(a, "counts", None)
    return {
        "id": str(a.id),
        "name": a.name,
        "cover": cover_url(uri, "400x400"),
        "genres": getattr(a, "genres", None) or [],
        "likes": getattr(a, "likes_count", None),
        "tracks_count": getattr(counts, "tracks", None) if counts else None,
    }


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/status")
def status():
    if not TOKEN:
        return jsonify({"authorized": False, "error": TOKEN_ERROR})
    info = {"authorized": True, "login": None, "plus": None}
    try:
        st = client.account_status()
        info["login"] = getattr(getattr(st, "account", None), "login", None)
        info["plus"] = getattr(getattr(st, "plus", None), "has_plus", None)
    except Exception as e:
        info["error"] = str(e)
    return jsonify(info)


@app.get("/api/search")
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    result = client.search(q, type_="track")
    tracks = result.tracks.results if result.tracks else []
    return jsonify([track_dto(t) for t in tracks])


@app.get("/api/search/artists")
def search_artists():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    result = client.search(q, type_="artist")
    items = result.artists.results if result.artists else []
    return jsonify([artist_dto(a) for a in items])


@app.get("/api/likes")
def likes():
    if not TOKEN:
        return jsonify({"error": "Нужен токен YANDEX_MUSIC_TOKEN"}), 401
    short = client.users_likes_tracks().tracks[:50]
    ids = [f"{s.id}:{s.album_id}" if s.album_id else str(s.id) for s in short]
    return jsonify([track_dto(t) for t in client.tracks(ids)])


@app.get("/api/artist/<artist_id>")
def artist(artist_id):
    """Страница артиста: профиль + популярные треки + альбомы (как в Яндекс Музыке)."""
    briefs = client.artists([artist_id])
    if not briefs:
        return jsonify({"error": "Артист не найден"}), 404
    info = artist_dto(briefs[0])

    popular = []
    try:
        tr = client.artists_tracks(artist_id, page=0, page_size=50)
        popular = [track_dto(t) for t in (tr.tracks or [])]
    except Exception as e:
        info["tracks_error"] = str(e)

    # Лучшие треки — у Яндекса это brief_info.popular_tracks; если есть, берём их.
    try:
        bi = client.artists_brief_info(artist_id)
        pt = getattr(bi, "popular_tracks", None) or []
        if pt:
            ids = [f"{s.id}:{s.albums[0].id}" if s.albums else str(s.id) for s in pt]
            popular = [track_dto(t) for t in client.tracks(ids)]
    except Exception:
        pass

    return jsonify({"artist": info, "popular_tracks": popular[:20]})


@app.get("/api/artist/<artist_id>/albums")
def artist_albums(artist_id):
    page = int(request.args.get("page", 0))
    res = client.artists_direct_albums(artist_id, page=page, page_size=50, sort_by="year")
    albums = [album_dto(a) for a in (res.albums or [])]
    albums.sort(key=lambda a: str(a["year"] or ""), reverse=True)
    return jsonify(albums)


@app.get("/api/album/<album_id>")
def album(album_id):
    a = client.albums_with_tracks(album_id)
    if not a:
        return jsonify({"error": "Альбом не найден"}), 404
    tracks = [t for vol in (a.volumes or []) for t in vol]
    return jsonify({"album": album_dto(a), "tracks": [track_dto(t) for t in tracks]})


# Качество звука. Яндекс отдаёт для трека несколько вариантов (по битрейту);
# «economy» и «standard» берут ближайший к целевому битрейту, «high» — максимальный.
QUALITY_TARGET = {"economy": 64, "standard": 128, "high": None}


def pick_download(infos, quality):
    # Как и раньше, предпочитаем mp3: он играет в любом браузере.
    pool = [i for i in infos if i.codec == "mp3"] or list(infos)

    def br(i):
        return i.bitrate_in_kbps or 0

    target = QUALITY_TARGET.get(quality, None)
    if target is None:
        return max(pool, key=br)
    return min(pool, key=lambda i: abs(br(i) - target))


# Получение прямой ссылки — самый медленный запрос (идёт через прокси), поэтому
# кэшируем результат: повторное воспроизведение и префетч следующего трека отдают
# ссылку мгновенно, без похода в Яндекс.
STREAM_TTL = 1800  # 30 минут: ссылки живут дольше, но обновляем с запасом
_stream_cache = {}
_stream_lock = threading.Lock()


def get_direct(track_id, quality):
    key = (track_id, quality)
    now = time.time()
    with _stream_lock:
        hit = _stream_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    infos = client.tracks_download_info(track_id, get_direct_links=True)
    if not infos:
        return None
    best = pick_download(infos, quality)
    payload = {
        "url": best.direct_link,
        "bitrate": best.bitrate_in_kbps,
        "codec": best.codec,
        "quality": quality,
    }
    with _stream_lock:
        _stream_cache[key] = (now + STREAM_TTL, payload)
    return payload


@app.get("/api/stream/<track_id>")
def stream(track_id):
    quality = request.args.get("quality", "high")
    payload = get_direct(track_id, quality)
    if not payload:
        return jsonify({"error": "Нет источников для этого трека"}), 404
    return jsonify(payload)


# ---------- Нравится / не нравится ----------

def need_token():
    return jsonify({"error": "Нужен токен YANDEX_MUSIC_TOKEN"}), 401


def _bare(i):
    """'123:456' -> '123' (в наборах лайков храним id без альбома)."""
    return str(i).split(":")[0]


@app.get("/api/likes/ids")
def likes_ids():
    """Все лайки одним запросом — чтобы фронтенд мог рисовать сердечки."""
    if not TOKEN:
        return jsonify({"tracks": [], "artists": [], "albums": [], "authorized": False})
    out = {"tracks": [], "artists": [], "albums": [], "authorized": True}
    try:
        out["tracks"] = [str(s.id) for s in (client.users_likes_tracks().tracks or [])]
    except Exception:
        pass
    try:
        out["artists"] = [str(getattr(l, "id", None) or l.artist.id)
                          for l in (client.users_likes_artists() or [])]
    except Exception:
        pass
    try:
        out["albums"] = [str(getattr(l, "id", None) or l.album.id)
                         for l in (client.users_likes_albums() or [])]
    except Exception:
        pass
    return jsonify(out)


@app.get("/api/likes/artists")
def likes_artists():
    if not TOKEN:
        return need_token()
    res = []
    for l in (client.users_likes_artists() or []):
        if getattr(l, "artist", None):
            res.append(artist_dto(l.artist))
    return jsonify(res)


@app.get("/api/likes/albums")
def likes_albums():
    if not TOKEN:
        return need_token()
    res = []
    for l in (client.users_likes_albums() or []):
        if getattr(l, "album", None):
            res.append(album_dto(l.album))
    return jsonify(res)


@app.post("/api/like")
def like():
    """Тело: {"kind": "track"|"artist"|"album", "id": "...", "like": true|false}"""
    if not TOKEN:
        return need_token()
    d = request.get_json(silent=True) or {}
    kind, oid, on = d.get("kind"), str(d.get("id") or ""), bool(d.get("like"))
    if not oid:
        return jsonify({"error": "Не указан id"}), 400
    fns = {
        ("track", True): client.users_likes_tracks_add,
        ("track", False): client.users_likes_tracks_remove,
        ("artist", True): client.users_likes_artists_add,
        ("artist", False): client.users_likes_artists_remove,
        ("album", True): client.users_likes_albums_add,
        ("album", False): client.users_likes_albums_remove,
    }
    fn = fns.get((kind, on))
    if not fn:
        return jsonify({"error": "Неизвестный тип"}), 400
    fn(oid)
    return jsonify({"ok": True, "kind": kind, "id": _bare(oid), "like": on})


@app.post("/api/dislike")
def dislike():
    """Тело: {"id": "...", "dislike": true|false}. Дизлайк заодно снимает лайк."""
    if not TOKEN:
        return need_token()
    d = request.get_json(silent=True) or {}
    oid, on = str(d.get("id") or ""), bool(d.get("dislike", True))
    if not oid:
        return jsonify({"error": "Не указан id"}), 400
    if on:
        client.users_dislikes_tracks_add(oid)
        try:
            client.users_likes_tracks_remove(oid)
        except Exception:
            pass
    else:
        client.users_dislikes_tracks_remove(oid)
    return jsonify({"ok": True, "id": _bare(oid), "dislike": on})


# ---------- Моя волна ----------

WAVE_DEFAULT = "user:onyourwave"
STATION_GROUPS = {"mood": "Настроение", "activity": "Занятие", "epoch": "Эпоха", "genre": "Жанр"}


@app.get("/api/wave/stations")
def wave_stations():
    if not TOKEN:
        return need_token()
    out = [{"id": WAVE_DEFAULT, "name": "Моя волна", "group": ""}]
    try:
        for r in (client.rotor_stations_list() or []):
            st = r.station
            sid = f"{st.id.type}:{st.id.tag}"
            group = STATION_GROUPS.get(st.id.type)
            if group and st.name:
                out.append({"id": sid, "name": st.name, "group": group})
    except Exception:
        pass  # список необязателен: «Моя волна» работает и без него
    return jsonify(out)


@app.get("/api/wave/tracks")
def wave_tracks():
    """Очередная порция треков станции. queue — id последнего сыгранного трека."""
    if not TOKEN:
        return need_token()
    station = request.args.get("station") or WAVE_DEFAULT
    queue = request.args.get("queue") or None
    res = client.rotor_station_tracks(station, queue=queue)
    tracks = []
    for item in (res.sequence or []):
        t = item.track
        if t is not None and getattr(t, "artists", None) is None and hasattr(t, "fetch_track"):
            t = t.fetch_track()
        if t is not None:
            tracks.append(track_dto(t))
    return jsonify({
        "station": station,
        "batch_id": getattr(res, "batch_id", None),
        "tracks": tracks,
    })


@app.post("/api/wave/feedback")
def wave_feedback():
    """Обратная связь, по которой волна подстраивается.
    type: radioStarted | trackStarted | trackFinished | skip"""
    if not TOKEN:
        return need_token()
    d = request.get_json(silent=True) or {}
    ev, station = d.get("type"), d.get("station") or WAVE_DEFAULT
    tid, batch = d.get("track_id"), d.get("batch_id")
    try:
        sec = float(d.get("seconds") or 0)
    except (TypeError, ValueError):
        sec = 0.0
    if ev == "radioStarted":
        client.rotor_station_feedback_radio_started(station, "ton-web", batch_id=batch)
    elif ev == "trackStarted" and tid:
        client.rotor_station_feedback_track_started(station, tid, batch_id=batch)
    elif ev == "trackFinished" and tid:
        client.rotor_station_feedback_track_finished(station, tid, sec, batch_id=batch)
    elif ev == "skip" and tid:
        client.rotor_station_feedback_skip(station, tid, sec, batch_id=batch)
    else:
        return jsonify({"error": "Неизвестное событие"}), 400
    return jsonify({"ok": True})


@app.errorhandler(Exception)
def on_error(e):
    if isinstance(e, HTTPException):  # 404 и т.п. оставляем как есть
        return jsonify({"error": e.description}), e.code
    return jsonify({"error": str(e)}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
