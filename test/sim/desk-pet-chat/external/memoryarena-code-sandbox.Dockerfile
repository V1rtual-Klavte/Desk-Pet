FROM python:3.10.20-slim-bookworm@sha256:019e31cc1f52e4139d338bca44f27b71339a9da261738fd80fab9cf4595152fc

RUN python -m pip install --no-cache-dir --disable-pip-version-check numpy==1.24.4 \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

WORKDIR /tmp
USER 10001:10001
ENTRYPOINT ["python", "-I", "-"]
