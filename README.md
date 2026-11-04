# Тон — Яндекс Музыка как Telegram Mini App

Flask-сервер + мобильный интерфейс. Работает внутри Telegram, хранит токен Яндекса на сервере.

## Деплой на Railway

1. Создайте репозиторий на GitHub и загрузите туда содержимое этой папки.
   Файл `token.txt` в репозиторий **не кладите** (он в `.gitignore`).
2. На railway.com: **New Project → Deploy from GitHub repo** и выберите репозиторий.
3. Во вкладке **Variables** добавьте:

   | Переменная | Значение |
   |---|---|
   | `YANDEX_MUSIC_TOKEN` | токен Яндекс Музыки |
   | `BOT_TOKEN` | токен бота от @BotFather |
   | `ALLOWED_USER_IDS` | ваш Telegram ID (узнать: @userinfobot), несколько через запятую |

4. Во вкладке **Settings → Networking** нажмите **Generate Domain**. Получите адрес вида `https://ton-production.up.railway.app`.

## Подключение к Telegram

1. В @BotFather: `/newbot` (или используйте существующего бота), скопируйте токен в `BOT_TOKEN`.
2. `/newapp`, выберите бота, укажите название и ссылку на Railway-домен. Либо проще:
   `/mybots → ваш бот → Bot Settings → Menu Button → Configure menu button` и вставьте адрес.
3. Откройте бота в Telegram и нажмите кнопку меню.

## Безопасность

- Сервер проверяет подпись `initData` от Telegram: без неё API отвечает 401.
  Без `BOT_TOKEN` на Railway API закрыт (ошибка 503), чтобы никто не слушал музыку и не ставил лайки с вашего аккаунта.
- `ALLOWED_USER_IDS` ограничивает доступ списком ID.
- Токен Яндекса храните только в переменных Railway. Если он где-то светился (например, в чате или в репозитории), получите новый.

## Локальный запуск

```
pip install -r requirements.txt
export YANDEX_MUSIC_TOKEN="..."
python server.py        # http://127.0.0.1:5000
```
Локально без `BOT_TOKEN` проверка Telegram отключена. Вне Telegram Mini App откроется как обычный сайт.

## Иконки

Lucide (https://lucide.dev, лицензия ISC), встроены как SVG-спрайт в `static/index.html`.
