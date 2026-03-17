FROM python:3.10-slim

WORKDIR /app

COPY server/requirements.txt ./requirements.txt

RUN pip3 install --no-cache-dir -r requirements.txt

COPY server/ ./

EXPOSE 8080

ENV PORT=8080

CMD ["python3", "server.py"]
