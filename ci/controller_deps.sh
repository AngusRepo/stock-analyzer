# Sourced from the repo root by run_suite.sh and rerun_controller.sh.
# Native Paper tests bundle worker/src with esbuild, so the controller also needs the worker's node_modules;
# test_nav_candidate_decision bundles a frontend render test, so it needs the frontend's too.
controller_deps() {
  (cd worker && npm ci --no-audit --no-fund) &&
    (cd frontend && npm ci --no-audit --no-fund) &&
    python -m pip install -q -r ml-controller/requirements.txt -c ml-controller/constraints.txt pytest==9.0.3 pytest-asyncio==1.4.0 \
      pytest-timeout==2.4.0 pytest-xdist==3.8.0
}
