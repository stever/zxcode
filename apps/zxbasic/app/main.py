from contextlib import asynccontextmanager
from fastapi import FastAPI, status, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from app.routes.compile import compile_endpoint
from app.process_monitor import process_monitor


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start the process monitor when the app starts.
    process_monitor.start()
    print("Process monitor started - will kill compilation processes older than 8 seconds")
    yield
    process_monitor.stop()


app = FastAPI(lifespan=lifespan)


# Security Headers Middleware
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        # Add security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # Only add HSTS for HTTPS connections
        if request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        return response


# Add security headers middleware
app.add_middleware(SecurityHeadersMiddleware)

# Configure CORS - permissive for compatibility with Hasura
# You can restrict allow_origins later if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for now - restrict this in production
    allow_credentials=True,
    allow_methods=["*"],  # Allow all methods
    allow_headers=["*"],  # Hasura sends various headers
    max_age=3600,
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=jsonable_encoder({"detail": exc.errors(), "body": exc.body}),
    )


# Health check endpoint for monitoring
@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "zxbasic-compiler"}


app.include_router(compile_endpoint, prefix='/compile')
