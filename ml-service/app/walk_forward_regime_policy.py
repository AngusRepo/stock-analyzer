"""R30 shared dated regime never dispatches a cutoff-specific HMM fit."""
MODES=('train_window','shared_dated_environment')

def mode(value):
    if value not in MODES:raise ValueError('walk_forward_regime_mode_invalid')
    return value

async def run_window(*, regime_mode, window_id, train_end, filtered_env, train):
    if mode(regime_mode)=='shared_dated_environment':
        return dict(status='not_trained',reason='shared_dated_production_environment',
            window_id=window_id,training_dispatched=False,artifact_created=False,
            historical_regime_reconstructed=False)
    return await train(dict(window_id=window_id,train_end=train_end,market_env=filtered_env(train_end)))
