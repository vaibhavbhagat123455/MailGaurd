"""
MailGuard Pro v7 - Prompt Injection Detector
Feature extraction mirrors train_injection.py EXACTLY.
"""

import re
import os
import numpy as np
import scipy.sparse as sp

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'models')

_classifier    = None
_vectorizer    = None
_scaler        = None
_struct_names  = None
_vectorizer_ok = False

def _load():
    global _classifier, _vectorizer, _scaler, _struct_names, _vectorizer_ok
    if _classifier is not None:
        return
    import joblib
    print("[MailGuard] Loading injection models...")
    _classifier   = joblib.load(os.path.join(MODEL_DIR, 'injection_classifier.pkl'))
    _vectorizer   = joblib.load(os.path.join(MODEL_DIR, 'injection_vectorizer.pkl'))
    _scaler       = joblib.load(os.path.join(MODEL_DIR, 'injection_scaler.pkl'))
    _struct_names = joblib.load(os.path.join(MODEL_DIR, 'injection_struct_features.pkl'))

    _vectorizer_ok = (
        hasattr(_vectorizer, 'vocabulary_') and
        len(getattr(_vectorizer, 'vocabulary_', {})) > 0 and
        hasattr(_vectorizer, 'idf_')
    )
    if _vectorizer_ok:
        print(f"[MailGuard] Injection vectorizer OK — vocab: {len(_vectorizer.vocabulary_)}")
    else:
        print("[MailGuard] WARNING: injection_vectorizer not fitted. Pattern-match only.")

# ── Constants — EXACT copy from train_injection.py ─────────────────────────
INJECTION_KEYWORDS = [
    "ignore", "disregard", "forget", "override", "bypass", "disable",
    "previous instructions", "system prompt", "your instructions",
    "pretend", "roleplay", "act as", "you are now", "from now on",
    "jailbreak", "dan mode", "developer mode", "unrestricted",
    "no restrictions", "no limitations", "safety filters",
    "reveal", "output your", "print your", "show your", "repeat your",
    "hidden instruction", "note to ai", "when an ai", "language model",
    "to the ai", "ai assistant", "attention ai",
    "new task", "new instruction", "real task", "actual task",
    "your real purpose", "your true purpose",
]

IMPERATIVE_VERBS = [
    "ignore", "forget", "disregard", "pretend", "act", "be", "become",
    "switch", "override", "bypass", "reveal", "output", "print", "show",
    "repeat", "disable", "enter", "activate", "enable", "execute",
    "perform", "simulate", "roleplay", "imagine", "assume",
]

META_REFERENCES = [
    "ai", "model", "system", "prompt", "instruction", "assistant",
    "bot", "chatbot", "llm", "gpt", "language model", "neural network",
    "context", "training", "guidelines", "rules", "policy", "filter",
]

# STRUCT_FEATURE_NAMES from train_injection.py (exact order)
STRUCT_FEATURE_NAMES = [
    "keyword_density", "imperative_ratio", "meta_reference_ratio",
    "second_person_ratio", "quoted_command_count", "has_brackets",
    "all_caps_ratio", "word_count", "sentence_count",
    "keyword_hits_raw", "imperative_hits_raw", "meta_hits_raw",
]

# ── Text cleaning — EXACT copy from train_injection.py ─────────────────────
def _clean_text(text):
    if not isinstance(text, str):
        return ""
    text = text.lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text

# ── Structural features — EXACT copy from train_injection.py ───────────────
def _structural_features(text):
    """Returns np.array of 12 features matching STRUCT_FEATURE_NAMES exactly."""
    if not isinstance(text, str):
        text = ""
    lower = text.lower()
    words = lower.split()
    word_count = max(len(words), 1)
    sentences  = re.split(r"[.!?]", text)
    sent_count = max(len([s for s in sentences if s.strip()]), 1)

    keyword_hits    = sum(1 for kw in INJECTION_KEYWORDS if kw in lower)
    imperative_hits = sum(1 for v in IMPERATIVE_VERBS if re.search(rf"\b{v}\b", lower))
    meta_hits       = sum(1 for m in META_REFERENCES if re.search(rf"\b{m}\b", lower))

    second_person   = len(re.findall(r"\byou\b|\byour\b|\byourself\b", lower))
    quoted_cmds     = len(re.findall(r'["\']([^"\']{5,})["\']', text))
    has_brackets    = int(bool(re.search(r"\[.*?\]|\{.*?\}|<.*?>", text)))
    all_caps_words  = sum(1 for w in words if w.isupper() and len(w) > 2)

    return np.array([
        keyword_hits / max(word_count / 10, 1),  # keyword_density
        imperative_hits / word_count,             # imperative_ratio
        meta_hits / word_count,                   # meta_reference_ratio
        second_person / word_count,               # second_person_ratio
        quoted_cmds,                              # quoted_command_count
        has_brackets,                             # has_brackets
        all_caps_words / word_count,              # all_caps_ratio
        word_count,                               # word_count
        sent_count,                               # sentence_count
        keyword_hits,                             # keyword_hits_raw
        imperative_hits,                          # imperative_hits_raw
        meta_hits,                                # meta_hits_raw
    ], dtype=np.float32)

# ── Pattern library for fallback + boost ───────────────────────────────────
PATTERNS = {
    'direct_override': [
        r'ignore\s+(all\s+)?previous\s+instructions?',
        r'disregard\s+(all\s+)?previous',
        r'forget\s+(all\s+)?(previous|your)',
        r'you\s+are\s+now\s+an?\s+unrestricted',
        r'new\s+instructions?\s*:',
        r'override\s+(previous|all)',
        r'do\s+not\s+follow\s+(your|the)\s+instructions?',
        r'your\s+new\s+(task|instructions?|directive)',
    ],
    'role_play': [
        r'pretend\s+(you\s+are|to\s+be)', r'act\s+as\s+an?\s+',
        r'you\s+are\s+now\s+(a|an)\s+', r'roleplay\s+as',
        r'play\s+the\s+role\s+of', r'simulate\s+(being|a)',
        r'impersonate',
    ],
    'data_exfiltration': [
        r'reveal\s+(your\s+)?(system\s+)?prompt',
        r'show\s+me\s+(your\s+)?(system\s+|internal\s+)?instructions?',
        r'what\s+(are|were)\s+your\s+(original\s+)?instructions?',
        r'repeat\s+(everything|all)\s+(above|before|prior)',
        r'print\s+(your\s+)?system\s+prompt',
        r'output\s+(the\s+)?(full|complete|entire)\s+(prompt|instructions?)',
    ],
    'jailbreak': [
        r'dan\s+mode', r'jailbreak', r'developer\s+mode',
        r'sudo\s+(mode|access)', r'no\s+restrictions?',
        r'without\s+(any\s+)?restrictions?',
        r'bypass\s+(your\s+)?(safety|restrictions?|filters?)',
        r'unlock\s+(all\s+)?capabilities',
        r'disable\s+(your\s+)?(safety|filters?|restrictions?)',
    ],
    'indirect': [
        r'for\s+(educational|research|testing)\s+purposes',
        r'hypothetically\s+speaking',
        r'in\s+a\s+fictional\s+(world|scenario|context)',
        r'this\s+is\s+just\s+a\s+(test|simulation)',
    ]
}

def _detect_patterns(text):
    found = []
    tl = text.lower()
    for itype, pats in PATTERNS.items():
        for pat in pats:
            m = re.search(pat, tl)
            if m:
                found.append({
                    'source': 'pattern_match', 'type': itype,
                    'matched': m.group(0), 'confidence': 0.9
                })
                break
    return found

# ── Main ─────────────────────────────────────────────────────────────────────
def analyze_injection(content: str) -> dict:
    _load()
    content = content.strip()[:2000]

    struct_names = list(_struct_names)  # from pkl (should match STRUCT_FEATURE_NAMES)
    classes      = list(_classifier.classes_)

    # Pattern matching always runs
    pat_evidence = _detect_patterns(content)

    # ── ML prediction ────────────────────────────────────────────────────────
    inj_prob = 0.0
    if _vectorizer_ok:
        try:
            cleaned  = _clean_text(content)
            tfidf    = _vectorizer.transform([cleaned])
            struct   = _structural_features(content).reshape(1, -1)
            struct_s = _scaler.transform(struct)
            combined = sp.hstack([tfidf, sp.csr_matrix(struct_s)])

            proba   = _classifier.predict_proba(combined)[0]
            inj_idx = next((i for i, c in enumerate(classes)
                            if str(c) in ('1', 'injection', 'malicious', 'attack')), 1)
            inj_prob = float(proba[inj_idx])
        except Exception as e:
            print(f"[MailGuard] Injection ML failed: {e}")
            inj_prob = 0.0
    else:
        # Struct-only fallback
        try:
            struct   = _structural_features(content).reshape(1, -1)
            struct_s = _scaler.transform(struct)
            proba    = _classifier.predict_proba(struct_s)
            inj_idx  = next((i for i, c in enumerate(classes)
                             if str(c) in ('1','injection','malicious','attack')), 1)
            inj_prob = float(proba[0][inj_idx])
        except Exception:
            inj_prob = min(len(pat_evidence) * 0.30, 0.80)

    # Boost from patterns
    boost      = min(len(pat_evidence) * 0.20, 0.50)
    final      = min(inj_prob + boost, 1.0)
    is_inj     = final > 0.45 or len(pat_evidence) > 0
    confidence = round(final * 100, 2)
    itype      = pat_evidence[0]['type'] if pat_evidence else ('ml_detected' if is_inj else 'safe')

    if is_inj:
        if confidence >= 86: risk_tier = 'critical'
        elif confidence >= 61: risk_tier = 'high'
        elif confidence >= 31: risk_tier = 'medium'
        else: risk_tier = 'low'
    else:
        risk_tier = 'low'

    # LIME evidence
    lime_ev = []
    if _vectorizer_ok:
        try:
            from lime.lime_text import LimeTextExplainer
            inj_idx_local = next((i for i, c in enumerate(classes)
                                  if str(c) in ('1','injection','malicious','attack')), 1)
            def _pred_fn(texts):
                out = []
                for t in texts:
                    tv  = _vectorizer.transform([_clean_text(t)])
                    sf  = _structural_features(t).reshape(1, -1)
                    sfs = _scaler.transform(sf)
                    c   = sp.hstack([tv, sp.csr_matrix(sfs)])
                    out.append(_classifier.predict_proba(c)[0])
                return np.array(out)
            exp = LimeTextExplainer(class_names=['safe', 'injection'])
            ex  = exp.explain_instance(_clean_text(content), _pred_fn, num_features=6, top_labels=1)
            label = classes[inj_idx_local]
            for tok, w in ex.as_list(label=label):
                lime_ev.append({'source': 'lime', 'token': tok, 'weight': round(float(w), 4)})
        except Exception:
            pass

    all_evidence    = (pat_evidence + lime_ev)[:10]
    score_breakdown = {
        'pattern_match': round(len(pat_evidence) * 22.0, 1),
        'ml_model':      round(inj_prob * 100, 1),
        'anomaly_score': round(final * 100, 1)
    }
    # Structural flags — which named features fired
    sf_vals = _structural_features(content)
    structural_flags = [
        struct_names[i] for i in range(min(len(struct_names), len(sf_vals)))
        if sf_vals[i] > 0 and struct_names[i] not in ('word_count', 'sentence_count')
    ][:6]

    rec = (f"Prompt injection detected ({itype.replace('_', ' ')}). "
           f"Block this input from the AI system."
           if is_inj else "No injection patterns detected. Input appears safe.")

    return {
        'prediction':       'injection' if is_inj else 'safe',
        'injection_type':   itype,
        'confidence':       confidence,
        'risk_tier':        risk_tier,
        'evidence':         all_evidence,
        'structural_flags': structural_flags,
        'score_breakdown':  score_breakdown,
        'recommendation':   rec
    }
