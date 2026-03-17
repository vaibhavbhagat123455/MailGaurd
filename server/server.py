"""
MailGuard Pro v7 — Local Python API Server
Run: python server.py   OR   double-click start.bat
Listens on: http://localhost:5000
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import traceback
import os

app = Flask(__name__)
CORS(app, origins=["*"])

# Lazy-loaded model functions
_email_fn   = None
_url_fn     = None
_inject_fn  = None

def get_email():
    global _email_fn
    if _email_fn is None:
        from analyze_email import analyze_email
        _email_fn = analyze_email
    return _email_fn

def get_url():
    global _url_fn
    if _url_fn is None:
        from analyze_url import analyze_url
        _url_fn = analyze_url
    return _url_fn

def get_inject():
    global _inject_fn
    if _inject_fn is None:
        from analyze_injection import analyze_injection
        _inject_fn = analyze_injection
    return _inject_fn

@app.route('/api/health', methods=['GET'])
def health():
    # Check all pkl files are present
    required = [
        'email_vectorizer.pkl', 'email_classifier.pkl', 'email_scaler.pkl',
        'url_classifier.pkl', 'url_label_encoder.pkl', 'url_feature_names.pkl',
        'injection_classifier.pkl', 'injection_vectorizer.pkl',
        'injection_scaler.pkl', 'injection_struct_features.pkl'
    ]
    models_dir = os.path.join(os.path.dirname(__file__), 'models')
    missing = [f for f in required if not os.path.exists(os.path.join(models_dir, f))]

    if missing:
        return jsonify({
            'status': 'error',
            'message': f'Missing {len(missing)} model file(s)',
            'missing_files': missing,
            'fix': f'Copy these .pkl files into: {models_dir}'
        }), 500

    return jsonify({
        'status': 'ok',
        'message': 'MailGuard API running on localhost:5000',
        'models_dir': models_dir,
        'all_files_present': True
    })

@app.route('/api/analyze', methods=['POST', 'OPTIONS'])
def analyze():
    if request.method == 'OPTIONS':
        return '', 204

    try:
        data = request.get_json(force=True, silent=True)
        if not data:
            return jsonify({'error': 'Invalid JSON body'}), 400

        input_type = data.get('type', '').lower().strip()
        content    = data.get('content', '').strip()

        if not content:
            return jsonify({'error': 'content field required'}), 400

        if input_type == 'email':
            result = get_email()(content, data.get('sender', ''))
        elif input_type == 'url':
            result = get_url()(content)
        elif input_type in ('prompt', 'injection'):
            result = get_inject()(content)
        else:
            return jsonify({
                'error': f'Invalid type "{input_type}". Must be: email, url, or prompt'
            }), 400

        return jsonify(result)

    except FileNotFoundError as e:
        models_dir = os.path.join(os.path.dirname(__file__), 'models')
        return jsonify({
            'error': f'Model file not found: {e.filename or str(e)}',
            'fix': f'Copy all 10 .pkl files into: {models_dir}'
        }), 500

    except RuntimeError as e:
        return jsonify({'error': str(e)}), 500

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'Analysis failed: {str(e)}'}), 500

@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin']  = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response

if __name__ == '__main__':
    models_dir = os.path.join(os.path.dirname(__file__), 'models')
    required = [
        'email_vectorizer.pkl', 'email_classifier.pkl', 'email_scaler.pkl',
        'url_classifier.pkl', 'url_label_encoder.pkl', 'url_feature_names.pkl',
        'injection_classifier.pkl', 'injection_vectorizer.pkl',
        'injection_scaler.pkl', 'injection_struct_features.pkl'
    ]

    print("=" * 60)
    print("  MailGuard Pro v7 — Local API Server")
    print("  http://localhost:5000/api/analyze")
    print("=" * 60)

    missing = [f for f in required if not os.path.exists(os.path.join(models_dir, f))]
    if missing:
        print(f"\n  WARNING: {len(missing)} model file(s) missing from {models_dir}:")
        for f in missing:
            print(f"    MISSING: {f}")
        print("\n  Copy all .pkl files to the models/ folder before scanning.")
    else:
        print(f"\n  All 10 model files found in {models_dir}")

    print("\n  Press CTRL+C to stop\n")
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
