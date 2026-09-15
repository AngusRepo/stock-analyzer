"""Complete leaf-distribution QRF research; never imported by serving code."""
import numpy as np
from sklearn.ensemble import RandomForestRegressor


class LeafQRF:
    """Bootstrap-weighted full empirical CDF, equally mixed across trees.

    Every in-bag response is retained with multiplicity * sample weight.
    The resulting mean equals sklearn's forest mean; conditional magnitudes
    are ratios of mixture moments, NOT means of leaf conditional magnitudes.
    """
    def __init__(self, **kwargs):
        self.forest = RandomForestRegressor(**kwargs)

    def fit(self, x, y, weights):
        x=np.asarray(x, float);y=np.asarray(y, float);w=np.asarray(weights, float)
        if x.ndim!=2 or y.shape!=(len(x),) or w.shape!=y.shape or not np.isfinite(x).all() or not np.isfinite(y).all() or not np.isfinite(w).all() or np.any(w<=0):
            raise ValueError('invalid_qrf_training_data')
        self.forest.fit(x,y,sample_weight=w)
        self.y=y;self.order=np.argsort(y,kind='stable');self.leaves=[];self.moments=[]
        for tree,sample in zip(self.forest.estimators_,self.forest.estimators_samples_):
            indices,counts=np.unique(sample,return_counts=True)
            leaf=tree.apply(x[indices]);groups={};table=np.zeros((tree.tree_.node_count,5))
            for node in np.unique(leaf):
                mask=leaf==node;ix=indices[mask];mass=w[ix]*counts[mask];mass=mass/mass.sum();v=y[ix]
                groups[int(node)]=(ix,mass)
                table[node]=[mass@v,mass@(v<0),mass@np.maximum(v,0),mass@np.maximum(-v,0),mass@(v>.0018)]
            self.leaves.append(groups);self.moments.append(table)
        return self

    def predict(self,x):
        x=np.asarray(x,float);mix=np.zeros((len(x),5))
        for tree,table in zip(self.forest.estimators_,self.moments):mix+=table[tree.apply(x)]/len(self.moments)
        mu,p,pos,neg,pnet=mix.T
        gain=np.divide(pos,1-p,out=np.zeros_like(pos),where=(1-p)>1e-14)
        loss=np.divide(neg,p,out=np.zeros_like(neg),where=p>1e-14)
        return [{'expected_return_gross':float(mu[i]),'p_loss':float(p[i]),'gain':float(gain[i]),'loss':float(loss[i]),
                 'probability_positive_net_return':float(pnet[i]),'gain_defined':bool(1-p[i]>1e-14),'loss_defined':bool(p[i]>1e-14)} for i in range(len(x))]

    def weights_at_leaves(self,nodes):
        weights=np.zeros(len(self.y))
        for node,groups in zip(nodes,self.leaves):
            ix,mass=groups[int(node)];weights[ix]+=mass/len(self.leaves)
        return weights

    def distributions(self,x):
        nodes=self.forest.apply(x)
        for row in nodes:yield self.weights_at_leaves(row)

    def quantiles(self,x,levels):
        q=np.asarray(levels,float)
        if np.any((q<0)|(q>1)):raise ValueError('invalid_quantile')
        result=[]
        for w in self.distributions(x):
            nonzero=self.order[w[self.order]>0];cdf=np.cumsum(w[nonzero]);cdf[-1]=1.
            result.append(self.y[nonzero[np.minimum(np.searchsorted(cdf,q,side='left'),len(nonzero)-1)]])
        return np.asarray(result)

    def crps(self,x,outcomes):
        """Exact weighted CDF CRPS in O(n log n) once + O(n) per query."""
        result=[];ys=self.y[self.order]
        for w,z in zip(self.distributions(x),outcomes):
            ws=w[self.order];cum=np.cumsum(ws)-ws;first=np.cumsum(ws*ys)-ws*ys
            half_pair=np.sum(ws*(ys*cum-first))
            result.append(float(w@np.abs(self.y-z)-half_pair))
        return np.asarray(result)
