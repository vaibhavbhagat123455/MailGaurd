"""
MailGuard Pro v7 - Email Phishing Detector
Feature extraction mirrors train_email.py EXACTLY.
"""

import re
import base64
import os
import numpy as np
import scipy.sparse as sp

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'models')

_vectorizer    = None
_classifier    = None
_scaler        = None
_vectorizer_ok = False

def _load():
    global _vectorizer, _classifier, _scaler, _vectorizer_ok
    if _classifier is not None:
        return
    import joblib
    print("[MailGuard] Loading email models...")
    _vectorizer = joblib.load(os.path.join(MODEL_DIR, 'email_vectorizer.pkl'))
    _classifier = joblib.load(os.path.join(MODEL_DIR, 'email_classifier.pkl'))
    _scaler     = joblib.load(os.path.join(MODEL_DIR, 'email_scaler.pkl'))

    _vectorizer_ok = (
        hasattr(_vectorizer, 'vocabulary_') and
        len(getattr(_vectorizer, 'vocabulary_', {})) > 0 and
        hasattr(_vectorizer, 'idf_')
    )
    if _vectorizer_ok:
        print(f"[MailGuard] Email vectorizer OK — vocab: {len(_vectorizer.vocabulary_)}")
    else:
        print("[MailGuard] WARNING: email_vectorizer not fitted. Using heuristic fallback.")

# ── Text cleaning — EXACT copy from train_email.py ─────────────────────────
def _decode_base64_parts(text):
    pattern = r"[A-Za-z0-9+/]{40,}={0,2}"
    def try_decode(m):
        try:
            return base64.b64decode(m.group()).decode("utf-8", errors="ignore")
        except Exception:
            return m.group()
    return re.sub(pattern, try_decode, text)

def _clean_text(text):
    """Mirrors clean_text() from train_email.py exactly."""
    if not isinstance(text, str):
        return ""
    text = _decode_base64_parts(text)
    text = re.sub(r"<[^>]+>", " ", text)               # strip HTML
    text = re.sub(r"http\S+|www\S+", " URLTOKEN ", text) # URLs → URLTOKEN
    text = re.sub(r"\S+@\S+", " EMAILTOKEN ", text)      # emails → EMAILTOKEN
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

# ── Handcrafted features — EXACT copy from train_email.py ─────────────────
URGENCY_KEYWORDS = [
    "urgent", "immediately", "suspended", "verify", "confirm", "expire",
    "limited time", "act now", "click here", "account blocked", "unusual activity",
    "security alert", "update required", "validate", "restricted", "locked"
]

def _handcrafted_features(raw_text):
    """
    8 features matching handcrafted_features() in train_email.py EXACTLY.
    Order: url_count, img_count, exclaim_ratio, caps_ratio,
           has_html, urgency_flag, link_ratio, word_count
    """
    if not isinstance(raw_text, str):
        raw_text = ""

    url_count  = len(re.findall(r"http\S+|www\S+", raw_text, re.I))
    img_count  = len(re.findall(r"<img", raw_text, re.I))
    words      = raw_text.split()
    word_count = max(len(words), 1)
    # caps_ratio: fraction of ALL-CAPS words (matches training)
    caps_ratio = sum(1 for w in words if w.isupper()) / word_count
    has_html   = int(bool(re.search(r"<[a-z][\s\S]*?>", raw_text, re.I)))
    urgency    = int(any(kw in raw_text.lower() for kw in URGENCY_KEYWORDS))
    link_ratio = min(url_count / max(word_count / 50, 1), 1.0)
    exclaim_ratio = raw_text.count("!") / word_count

    return [url_count, img_count, exclaim_ratio, caps_ratio,
            has_html, urgency, link_ratio, word_count]

def _risk_tier(confidence, prediction):
    if prediction != 'phishing':
        return 'low'
    if confidence >= 86: return 'critical'
    if confidence >= 61: return 'high'
    if confidence >= 31: return 'medium'
    return 'low'

def _recommendation(prediction, confidence):
    if prediction == 'phishing':
        if confidence >= 86:
            return "Do not click any links. Report this email to your security team and quarantine the sender domain."
        elif confidence >= 61:
            return "Exercise caution. Do not click links or download attachments without verifying sender identity."
        else:
            return "Some suspicious indicators detected. Proceed with caution and verify the sender before acting."
    return "This email appears legitimate. Normal risk profile detected."

# ── Heuristic fallback (when vectorizer not fitted) ─────────────────────────
PHISHING_KW = [
    ("verify your account", 0.22), ("click here", 0.18),
    ("account suspended", 0.20),   ("account has been", 0.16),
    ("confirm your", 0.15),        ("unusual activity", 0.18),
    ("your password", 0.14),       ("update your information", 0.17),
    ("limited time", 0.13),        ("act now", 0.18),
    ("urgent", 0.12),              ("immediately", 0.11),
    ("expires", 0.10),             ("winner", 0.14),
    ("congratulations", 0.12),     ("free gift", 0.16),
    ("claim your", 0.15),          ("bank account", 0.09),
    ("social security", 0.14),     ("login credentials", 0.16),
    ("dear customer", 0.10),       ("suspended", 0.15),
    ("security alert", 0.16),      ("validate", 0.13),
    ("account blocked", 0.17),     ("locked", 0.12),
]
SAFE_KW = [
    ("unsubscribe", -0.08), ("regards", -0.06), ("best wishes", -0.05),
    ("sincerely", -0.05),   ("newsletter", -0.07), ("meeting", -0.05),
    ("calendar", -0.04),    ("team", -0.03),
]

def _heuristic_score(text, sender=''):
    tl = text.lower()
    score = sum(w for kw, w in PHISHING_KW if kw in tl)
    score += sum(w for kw, w in SAFE_KW if kw in tl)
    urls = len(re.findall(r"http\S+|www\S+", text, re.I))
    if urls > 2: score += 0.10
    if sender:
        domain = sender.split('@')[-1].lower() if '@' in sender else sender.lower()
        if any(domain.endswith(t) for t in ['.xyz','.tk','.ml','.cf','.ga','.top','.click']):
            score += 0.20
        if re.search(r'[a-z]+[0-9][a-z]+\.(com|net|org)', domain):
            score += 0.18
    return max(0.0, min(1.0, score))

def _heuristic_evidence(text):
    tl  = text.lower()
    ev  = [{'token': kw, 'weight': round(w, 4)} for kw, w in PHISHING_KW if kw in tl]
    ev += [{'token': kw, 'weight': round(w, 4)} for kw, w in SAFE_KW   if kw in tl]
    return sorted(ev, key=lambda x: abs(x['weight']), reverse=True)[:8]

# ── Main ────────────────────────────────────────────────────────────────────
def analyze_email(content: str, sender: str = '') -> dict:
    _load()

    content = content[:10000]

    if len(content.strip()) < 5:
        return {
            'prediction': 'unknown', 'confidence': 0, 'risk_tier': 'low',
            'evidence': [], 'recommendation': 'Email too short for analysis.',
            'warning': 'Content too short for reliable classification.'
        }

    if _vectorizer_ok:
        try:
            # Clean text same way training did
            cleaned   = _clean_text(content)
            tfidf_vec = _vectorizer.transform([cleaned])

            # Handcrafted on RAW text (same as training)
            hc_raw    = _handcrafted_features(content)
            hc_scaled = _scaler.transform([hc_raw])

            # Combine: sp.hstack([tfidf, sparse(hand)])
            combined  = sp.hstack([tfidf_vec, sp.csr_matrix(hc_scaled)])

            proba   = _classifier.predict_proba(combined)[0]
            classes = list(_classifier.classes_)

            # classes are 0=safe, 1=phishing
            phi_idx    = next((i for i, c in enumerate(classes)
                               if str(c) in ('1','phishing','spam','malicious')), 1)
            phi_prob   = float(proba[phi_idx])
            saf_prob   = 1.0 - phi_prob
            prediction = 'phishing' if phi_prob > 0.5 else 'safe'
            confidence = round((phi_prob if prediction == 'phishing' else saf_prob) * 100, 2)
            risk_tier  = _risk_tier(confidence, prediction)

            # Evidence via LIME, fallback to coef weights
            evidence = []
            try:
                from lime.lime_text import LimeTextExplainer
                def _pred_fn(texts):
                    out = []
                    for t in texts:
                        tv = _vectorizer.transform([_clean_text(t)])
                        hc = _scaler.transform([_handcrafted_features(t)])
                        c  = sp.hstack([tv, sp.csr_matrix(hc)])
                        out.append(_classifier.predict_proba(c)[0])
                    return np.array(out)
                exp = LimeTextExplainer(class_names=['safe','phishing'])
                ex  = exp.explain_instance(cleaned, _pred_fn, num_features=8, top_labels=1)
                label_key = classes[phi_idx]
                for tok, w in ex.as_list(label=label_key):
                    evidence.append({'token': tok, 'weight': round(float(w), 4)})
            except Exception:
                try:
                    feat_names = _vectorizer.get_feature_names_out()
                    coefs      = _classifier.coef_[0]
                    arr        = tfidf_vec.toarray()[0]
                    pairs = [(feat_names[i], float(coefs[i] * arr[i]))
                             for i in range(len(feat_names)) if arr[i] > 0]
                    pairs.sort(key=lambda x: abs(x[1]), reverse=True)
                    evidence = [{'token': p[0], 'weight': round(p[1], 4)} for p in pairs[:8]]
                except Exception:
                    evidence = []

            result = {
                'prediction':    prediction,
                'confidence':    confidence,
                'risk_tier':     risk_tier,
                'evidence':      evidence,
                'recommendation': _recommendation(prediction, confidence),
                'warning':       None
            }
            if sender:
                result['sender_domain'] = sender.split('@')[-1] if '@' in sender else sender
            return result

        except Exception as e:
            print(f"[MailGuard] Email ML failed: {e}, falling back to heuristics")

    # ── Heuristic fallback ──────────────────────────────────────────────────
    hf = _handcrafted_features(content)
    try:
        hf_sc = _scaler.transform([hf])[0]
        boost = float(hf_sc[5]) * 0.08 + min(float(hf_sc[6]) * 0.05, 0.10)
    except Exception:
        boost = 0.0

    h_score    = min(1.0, _heuristic_score(content, sender) + boost)
    prediction = 'phishing' if h_score > 0.30 else 'safe'
    confidence = round(h_score * 100 if prediction == 'phishing' else (1 - h_score) * 100, 2)
    risk_tier  = _risk_tier(confidence, prediction)

    result = {
        'prediction':    prediction,
        'confidence':    confidence,
        'risk_tier':     risk_tier,
        'evidence':      _heuristic_evidence(content),
        'recommendation': _recommendation(prediction, confidence),
        'warning':       'Scored using keyword heuristics (vectorizer not fitted).'
    }
    if sender:
        result['sender_domain'] = sender.split('@')[-1] if '@' in sender else sender
    return result
