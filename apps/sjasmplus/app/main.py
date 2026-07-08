from fastapi import FastAPI, status, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from starlette.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from app.routes.compile import compile_endpoint


app = FastAPI()


# This service is a Hasura action webhook. Hasura requires error responses to be
# shaped as {"message": ...} (parsed into ActionWebhookErrorResponse); FastAPI's
# default {"detail": ...} makes Hasura fail with
# 'ActionWebhookErrorResponse ... key "message" not found' and the UI never
# gets a clean failure. Reshape both HTTPException and request-validation
# errors into Hasura's format.
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    message = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"message": message},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={
            "message": "Invalid compile request.",
            "extensions": {"errors": jsonable_encoder(exc.errors())},
        },
    )


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "sjasmplus-compiler"}


app.include_router(compile_endpoint, prefix='/compile')
