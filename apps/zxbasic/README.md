![Boriel ZX Basic](img/zxbasic_logo.png)

# ZX Play API for ZX Basic

Programs target the classic 48K Spectrum by default. See [NEXT.md](NEXT.md)
for writing ZX Spectrum Next programs (Z80N, Layer 2, hardware sprites) and
how the service selects the zxnext architecture.

## Development start

### Initial project setup

```bash
git clone https://github.com/stever/zxcode-api-zxbasic.git
cd zxcode-api-zxbasic/
virtualenv venv
source ./venv/bin/activate
pip install -r requirements.txt
```

### Run app

```bash
uvicorn app.main:app --reload
```

## Docker Build & Push

```bash
docker build -t ghcr.io/stever/zxcode-api-zxbasic .
docker push ghcr.io/stever/zxcode-api-zxbasic
```

## Run Locally

```bash
docker run \
  --env=API_URL=https://code.zxplay.org/api/v1/graphql \
  --publish=80:8000 \
  --detach=true \
  --name=zxcode-api-zxbasic \
  ghcr.io/stever/zxcode-api-zxbasic
```

## API Integration

Reached through the `compile` mutation on apps/api, which forwards the
Hasura-style action-webhook envelope (`input` + `session_variables` +
forwarded client headers for rate limiting) to this service's handler at:

```
http://zxbasic/compile/
```
