"""Independent signal and label-knowledge bounds; calendar-derived, never backdated."""
from dataclasses import dataclass
from datetime import date, datetime

@dataclass(frozen=True)
class TrainingCutoff:
    signal_date_max: str
    label_known_at_max: str

    def __post_init__(self):
        for value in (self.signal_date_max, self.label_known_at_max):
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError("training_cutoff_date_invalid")
        if self.signal_date_max >= self.label_known_at_max:
            raise ValueError("training_signal_must_precede_label_knowledge")

    def admits(self, signal_date, label_known_at):
        signal, known = str(signal_date)[:10], str(label_known_at)[:10]
        date.fromisoformat(signal); date.fromisoformat(known)
        return signal < known and signal <= self.signal_date_max and known <= self.label_known_at_max

    @classmethod
    def from_calendar(cls, sessions, *, first_evaluation_signal, horizon=5):
        if sessions != sorted(set(sessions)) or horizon < 1:
            raise ValueError("training_cutoff_calendar_invalid")
        for session in sessions: date.fromisoformat(session)
        if first_evaluation_signal not in sessions:
            raise ValueError("training_cutoff_evaluation_session_missing")
        eligible = [(sessions[i],sessions[i+horizon]) for i in range(len(sessions)-horizon)
                    if sessions[i+horizon] < first_evaluation_signal]
        if not eligible: raise ValueError("training_cutoff_calendar_insufficient")
        return cls(*eligible[-1])

    def attest(self, *, component, signals, known_dates, feature_vintage, ancestor_cutoff, trained_at):
        if not signals or len(signals) != len(known_dates):
            raise ValueError("training_cutoff_empty_or_misaligned_rows")
        if not all(self.admits(s,k) for s,k in zip(signals,known_dates)):
            raise ValueError("training_cutoff_rows_exceeded:"+component)
        if not feature_vintage or not ancestor_cutoff or ancestor_cutoff > self.label_known_at_max:
            raise ValueError("training_cutoff_ancestry_or_vintage_missing:"+component)
        stamp=datetime.fromisoformat(trained_at.replace('Z','+00:00'))
        if stamp.tzinfo is None or stamp.date().isoformat() < max(known_dates):
            raise ValueError("training_cutoff_actual_fit_time_invalid:"+component)
        return dict(component=component,signal_date_max=max(signals),
            label_known_at_max=max(known_dates),feature_vintage=feature_vintage,
            ancestor_cutoff=ancestor_cutoff,trained_at=trained_at,
            requested_signal_date_max=self.signal_date_max,
            requested_label_known_at_max=self.label_known_at_max,rows=len(signals))


def request_cutoff_from_environment(environment):
    signal=environment.get('OOF_MATERIALIZE_SIGNAL_DATE_MAX','').strip()
    known=environment.get('OOF_MATERIALIZE_LABEL_KNOWN_AT_MAX','').strip()
    if not signal and not known:return {}
    if not signal or not known:raise ValueError('training_dual_cutoff_requires_both_bounds')
    cutoff=TrainingCutoff(signal,known)
    if environment.get('OOF_MATERIALIZE_END_DATE','').strip()!=known:
        raise ValueError('training_knowledge_cutoff_alias_conflict')
    return dict(signal_date_max=cutoff.signal_date_max,label_known_at_max=cutoff.label_known_at_max)
