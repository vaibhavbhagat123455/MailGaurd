FROM python:3.10-slim

RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt ./requirements.txt

RUN pip3 install --no-cache-dir --upgrade pip && \
    pip3 install --no-cache-dir -r requirements.txt

COPY server/ ./

EXPOSE 8080

ENV PORT=8080

CMD ["python3", "server.py"]
