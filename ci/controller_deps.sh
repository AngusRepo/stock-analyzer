# Sourced from the repo root by run_suite.sh and rerun_controller.sh.
# Native Paper tests bundle worker/src with esbuild, so the controller also needs the worker's node_modules;
# test_nav_candidate_decision bundles a frontend render test, so it needs the frontend's too.
# constraints.txt pins the live image's packages; a base commit from before it installs unpinned.
controller_deps() {
  local pins=()
  [ -f ml-controller/constraints.txt ] && pins=(-c ml-controller/constraints.txt)
  (cd worker && npm ci --no-audit --no-fund) &&
    # The image compiles the Worker to /app/worker-dist; scripts resolve it as ../worker-dist from
    # ml-controller/scripts, so tests that run those scripts need the same compile here.
    (cd worker && npx tsc -p tsconfig.json --noEmit false --rootDir src --outDir ../ml-controller/worker-dist/src --module commonjs --moduleResolution node --ignoreDeprecations 6.0) &&
    (cd frontend && npm ci --no-audit --no-fund) &&
    python -m pip install -q -r ml-controller/requirements.txt "${pins[@]}" pytest==9.0.3 pytest-asyncio==1.4.0 \
      pytest-timeout==2.4.0 pytest-xdist==3.8.0
}
