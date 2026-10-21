# Sourced from the repo root by run_suite.sh and rerun_controller.sh.
# Native Paper tests bundle worker/src with esbuild, so the controller also needs the worker's node_modules.
controller_deps() {
  (cd worker && npm ci --no-audit --no-fund) &&
    python -m pip install -q -r ml-controller/requirements.txt pytest==9.0.3 pytest-asyncio==1.4.0 \
      pytest-timeout==2.4.0 pytest-xdist==3.8.0
}
