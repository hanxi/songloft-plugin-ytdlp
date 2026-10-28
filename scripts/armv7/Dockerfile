# Build with the checked-out upstream yt-dlp release as the context.
FROM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322 AS builder
RUN apk add --no-cache build-base zlib-dev libffi-dev binutils
WORKDIR /src
COPY . .
RUN python devscripts/install_deps.py --include-group pyinstaller --include pin
ARG YTDLP_VERSION
RUN python devscripts/update-version.py "${YTDLP_VERSION}" && \
    python devscripts/make_lazy_extractors.py && \
    python -m bundle.pyinstaller --onefile
RUN mkdir -p /out && \
    cp dist/yt-dlp_musllinux_armv7l /out/ && \
    cp LICENSE /out/yt-dlp-LICENSE && \
    cp THIRD_PARTY_LICENSES.txt /out/yt-dlp-THIRD_PARTY_LICENSES.txt && \
    pip freeze > /out/yt-dlp-python-requirements.txt && \
    readelf -h dist/yt-dlp_musllinux_armv7l && \
    readelf -l dist/yt-dlp_musllinux_armv7l && \
    dist/yt-dlp_musllinux_armv7l --version

FROM scratch
COPY --from=builder /out/ /
