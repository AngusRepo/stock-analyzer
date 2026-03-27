FROM freqtradeorg/freqtrade:stable

# D1 API client + result import
RUN pip install --no-cache-dir requests

COPY strategies/ /freqtrade/user_data/strategies/
COPY scripts/ /freqtrade/scripts/
COPY config.json /freqtrade/

RUN chmod +x /freqtrade/scripts/run_backtest.sh

WORKDIR /freqtrade

# Cloud Run Job entrypoint (override with docker-compose for local dev)
ENTRYPOINT ["/bin/bash", "/freqtrade/scripts/run_backtest.sh"]
