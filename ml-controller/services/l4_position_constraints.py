"""Pre-seal N1/N3 constraints. No candidate ranking or post-seal redistribution."""
import math
import numpy as np

def position_constraints(symbols, rows, holdings, history, limits):
    groups = {}
    if 'max_per_sector' in limits:
        maximum=limits['max_per_sector']
        if type(maximum) is not int or maximum<1: raise ValueError('l4_sector_count_invalid')
        for symbol in symbols:
            sector=str((rows.get(symbol) or holdings.get(symbol) or {}).get('sector') or 'UNKNOWN').strip().upper()
            groups.setdefault('sector:'+sector, {'symbols':[], 'max_count':maximum})['symbols'].append(symbol)
    pairs=[]
    if 'correlation_threshold' in limits:
        threshold=limits['correlation_threshold'];window=limits.get('correlation_window',60)
        if not isinstance(threshold,(int,float)) or not math.isfinite(threshold) or not 0<=threshold<=1 or type(window) is not int or not 20<=window<=504:
            raise ValueError('l4_position_correlation_invalid')
        raw=history.get('returns') if history.get('schema_version')=='l4-dated-risk-v1' else history
        width=min(window,max((len(raw.get(s) or []) for s in symbols),default=0))
        x=np.full((width,len(symbols)),np.nan)
        for i,s in enumerate(symbols):
            values=(raw.get(s) or [])[-width:] if width else []
            if values:x[-len(values):,i]=[float(v) if v is not None else np.nan for v in values]
        mask=np.isfinite(x).astype(float);zero=np.where(np.isfinite(x),x,0.)
        count=mask.T@mask;sums=zero.T@mask
        with np.errstate(divide='ignore',invalid='ignore'):
            cov=zero.T@zero-sums*sums.T/count
            variance=(zero*zero).T@mask-sums*sums/count
            corr=cov/np.sqrt(variance*variance.T)
        for i,j in zip(*np.where(np.triu((count>=20)&np.isfinite(corr)&(corr>=threshold),1))):
            pairs.append([symbols[i],symbols[j]])
    return groups,pairs
