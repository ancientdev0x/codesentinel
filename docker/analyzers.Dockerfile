FROM python:3.12-slim
RUN pip install --no-cache-dir bandit==1.9.4 ruff==0.16.10
RUN useradd -u 10001 -M analyzer
USER 10001
WORKDIR /src
