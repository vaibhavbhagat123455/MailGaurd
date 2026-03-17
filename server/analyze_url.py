"""
MailGuard Pro v7 - Malicious URL Classifier
Feature extraction mirrors train_url.py EXACTLY.
"""

import re
import math
import os
import numpy as np
from collections import Counter
from urllib.parse import urlparse

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'models')

_classifier    = None
_label_encoder = None
_feature_names = None

def _load():
    global _classifier, _label_encoder, _feature_names
    if _classifier is not None:
        return
    import joblib
    print("[MailGuard] Loading URL models...")
    _classifier    = joblib.load(os.path.join(MODEL_DIR, 'url_classifier.pkl'))
    _label_encoder = joblib.load(os.path.join(MODEL_DIR, 'url_label_encoder.pkl'))
    _feature_names = joblib.load(os.path.join(MODEL_DIR, 'url_feature_names.pkl'))
    print(f"[MailGuard] URL features ({len(_feature_names)}): {list(_feature_names)}")

# ── Constants — EXACT copy from train_url.py ──────────────────────────────
KNOWN_BRANDS = [
    "paypal", "amazon", "apple", "google", "microsoft", "facebook",
    "netflix", "instagram", "twitter", "linkedin", "dropbox", "github",
    "whatsapp", "zoom", "wellsfargo", "bankofamerica", "chase", "citibank",
    "hsbc", "dhl", "fedex", "ups", "usps", "irs", "ebay", "walmart"
]

SUSPICIOUS_EXTENSIONS = [
    ".exe", ".zip", ".bat", ".js", ".vbs", ".ps1", ".msi", ".dmg", ".apk"
]

SUSPICIOUS_PATH_KEYWORDS = [
    "login", "signin", "sign-in", "verify", "secure", "account",
    "update", "confirm", "banking", "authenticate", "validation",
    "recover", "password", "credential", "submit", "checkout"
]

TLD_RISK = {
    ".tk": 0.95, ".ml": 0.95, ".ga": 0.95, ".cf": 0.95, ".gq": 0.95,
    ".xyz": 0.70, ".top": 0.70, ".club": 0.70, ".online": 0.70,
    ".site": 0.70, ".info": 0.65, ".biz": 0.60,
    ".co": 0.40, ".io": 0.35,
    ".com": 0.15, ".net": 0.18, ".org": 0.15,
    ".gov": 0.02, ".edu": 0.02, ".mil": 0.02,
    ".uk": 0.20, ".in": 0.22, ".de": 0.18, ".fr": 0.18,
    ".au": 0.18, ".ca": 0.18, ".jp": 0.20, ".br": 0.25,
    ".ru": 0.55, ".cn": 0.50,
}

URL_SHORTENERS = {
    "bit.ly", "tinyurl.com", "goo.gl", "t.co", "ow.ly",
    "is.gd", "buff.ly", "adf.ly", "short.link", "rebrand.ly",
    "cutt.ly", "shorturl.at", "tiny.cc"
}

# ── Helpers — EXACT copy from train_url.py ─────────────────────────────────
def _shannon_entropy(s):
    if not s:
        return 0.0
    freq   = Counter(s)
    length = len(s)
    return -sum((c / length) * math.log2(c / length) for c in freq.values())

def _is_ip_address(hostname):
    ipv4 = re.match(r"^(\d{1,3}\.){3}\d{1,3}$", hostname or "")
    if ipv4:
        return all(0 <= int(p) <= 255 for p in hostname.split("."))
    return bool(re.match(r"^\[?[0-9a-fA-F:]+\]?$", hostname or ""))

def _get_registered_domain(hostname):
    parts = hostname.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else hostname

def _extract_features(url):
    """EXACT copy of extract_features() from train_url.py"""
    if not isinstance(url, str):
        url = ""
    url = url.strip()

    try:
        parsed   = urlparse(url if "://" in url else "http://" + url)
        scheme   = parsed.scheme.lower()
        hostname = parsed.hostname or ""
        path     = parsed.path or ""
        query    = parsed.query or ""
        netloc   = parsed.netloc or ""
    except Exception:
        hostname, scheme, path, query, netloc = "", "http", "", "", ""

    full_url       = url.lower()
    registered_dom = _get_registered_domain(hostname.lower())
    subdomain_part = hostname.lower().replace(registered_dom, "").strip(".")
    tld            = "." + registered_dom.split(".")[-1] if "." in registered_dom else ""

    f = {}

    f["url_length"]           = len(url)
    f["hostname_length"]      = len(hostname)
    f["path_length"]          = len(path)
    f["query_length"]         = len(query)

    f["dot_count"]            = url.count(".")
    f["hyphen_count"]         = url.count("-")
    f["underscore_count"]     = url.count("_")
    f["slash_count"]          = url.count("/")
    f["question_count"]       = url.count("?")
    f["equals_count"]         = url.count("=")
    f["ampersand_count"]      = url.count("&")
    f["at_symbol"]            = int("@" in netloc)
    f["hash_count"]           = url.count("#")
    f["double_slash_in_path"] = int("//" in path)

    digits_in_url           = sum(c.isdigit() for c in url)
    specials                = sum(not c.isalnum() and c not in "/:.-_?=&#@%" for c in url)
    f["digit_count"]        = digits_in_url
    f["digit_ratio"]        = digits_in_url / max(len(url), 1)
    f["special_char_count"] = specials
    f["special_char_ratio"] = specials / max(len(url), 1)

    f["url_entropy"]    = round(_shannon_entropy(full_url), 4)
    f["domain_entropy"] = round(_shannon_entropy(hostname.lower()), 4)

    f["is_ip_hostname"] = int(_is_ip_address(hostname))
    f["is_https"]       = int(scheme == "https")
    f["is_shortener"]   = int(registered_dom in URL_SHORTENERS)

    f["subdomain_count"]  = len([s for s in subdomain_part.split(".") if s]) if subdomain_part else 0
    f["subdomain_length"] = len(subdomain_part)

    f["tld_risk_score"] = TLD_RISK.get(tld, 0.80)

    path_lower              = path.lower()
    f["suspicious_keywords"] = int(any(
        kw in path_lower or kw in query.lower()
        for kw in SUSPICIOUS_PATH_KEYWORDS
    ))
    f["suspicious_ext"] = int(any(path_lower.endswith(ext) for ext in SUSPICIOUS_EXTENSIONS))

    f["digit_ratio_domain"] = sum(c.isdigit() for c in hostname) / max(len(hostname), 1)
    f["non_ascii_ratio"]    = sum(1 for c in hostname if ord(c) > 127) / max(len(hostname), 1)
    f["has_hex_encoding"]   = int(bool(re.search(r"%[0-9a-fA-F]{2}", url)))
    f["path_depth"]         = len([p for p in path.split("/") if p])

    words_in_path         = re.findall(r"[a-zA-Z]{3,}", path)
    f["longest_word_path"] = max((len(w) for w in words_in_path), default=0)

    brand_in_url          = any(brand in full_url for brand in KNOWN_BRANDS)
    brand_in_domain       = any(brand in registered_dom for brand in KNOWN_BRANDS)
    f["brand_impersonation"] = int(brand_in_url and not brand_in_domain)

    f["unique_char_ratio"] = len(set(url)) / max(len(url), 1)

    return f

def _adversarial_flags(url, hostname, brand_imp):
    flags = []
    if brand_imp:
        registered = _get_registered_domain(hostname.lower())
        for b in KNOWN_BRANDS:
            if b in url.lower() and b not in registered:
                flags.append(f"brand_impersonation_{b}_in_url_but_not_registered_domain")
                break
    if _is_ip_address(hostname):
        flags.append("ip_address_used_as_domain")
    if "//" in url[8:]:
        flags.append("embedded_redirect_detected")
    return flags

def analyze_url(url: str) -> dict:
    _load()
    url = url.strip()[:2000]

    feature_names = list(_feature_names)
    feat_dict     = _extract_features(url)
    features      = [feat_dict.get(n, 0) for n in feature_names]
    feat_arr      = np.array([features], dtype=np.float32)

    # Class names from label encoder
    if hasattr(_label_encoder, 'classes_'):
        classes = list(_label_encoder.classes_)
    else:
        classes = ['benign', 'defacement', 'malware', 'phishing']

    proba    = _classifier.predict_proba(feat_arr)[0]
    pred_idx = int(np.argmax(proba))
    pred_cls = classes[pred_idx] if pred_idx < len(classes) else 'unknown'

    malicious  = pred_cls.lower() not in ('benign', 'safe', 'legitimate')
    confidence = round(float(proba[pred_idx]) * 100, 2)

    if malicious:
        if confidence >= 86: risk_tier = 'critical'
        elif confidence >= 61: risk_tier = 'high'
        elif confidence >= 31: risk_tier = 'medium'
        else: risk_tier = 'low'
    else:
        risk_tier = 'low'

    all_class_scores = {c: round(float(p) * 100, 2) for c, p in zip(classes, proba)}

    # Evidence via feature importance (SHAP disabled — PyTorch DLL conflict)
    evidence = []
    try:
        imps  = _classifier.feature_importances_
        # Prioritise features with non-zero values for this specific URL
        pairs = sorted(
            [(feature_names[i], float(imps[i]), float(features[i]))
             for i in range(len(feature_names))],
            key=lambda x: (x[2] != 0, x[1]),
            reverse=True
        )
        active = [(n, imp) for n, imp, val in pairs if val != 0][:8]
        if len(active) < 4:
            active = [(n, imp) for n, imp, _ in pairs[:8]]
        evidence = [{'feature': n, 'shap_value': round(imp, 4)} for n, imp in active]
    except Exception as e:
        print(f"[MailGuard] URL evidence failed: {e}")

    # Adversarial
    try:
        parsed   = urlparse(url if "://" in url else "http://" + url)
        hostname = parsed.hostname or ""
    except Exception:
        hostname = ""
    adv_flags = _adversarial_flags(url, hostname, feat_dict.get('brand_impersonation', 0))

    rec = (f"Block this URL immediately. Do not visit. Threat type: {pred_cls}. "
           f"Report to your security team."
           if malicious else "This URL appears safe. Normal risk profile detected.")

    return {
        'prediction':         'malicious' if malicious else 'safe',
        'threat_type':        pred_cls,
        'confidence':         confidence,
        'risk_tier':          risk_tier,
        'all_class_scores':   all_class_scores,
        'evidence':           evidence,
        'adversarial_flags':  adv_flags,
        'adversarial_warning': adv_flags[0].replace('_', ' ') if adv_flags else None,
        'features_extracted': len(features),
        'recommendation':     rec
    }
