import json
import math
import os
import pickle
import sys
from pathlib import Path


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj))
    sys.exit(code)


def load_payload():
    raw = sys.stdin.read() or "{}"
    try:
        return json.loads(raw)
    except Exception as exc:
        emit({"ok": False, "error": f"Invalid JSON payload: {exc}", "code": "INVALID_JSON"}, 1)


def probe_dependencies():
    import importlib.util
    names = [
        "sklearn",
        "xgboost",
        "lightgbm",
        "catboost",
        "hmmlearn",
        "torch",
        "transformers",
        "stable_baselines3",
        "ray",
        "vaderSentiment",
        "gymnasium",
    ]
    return {name: bool(importlib.util.find_spec(name)) for name in names}


def sigmoid(value):
    return 1.0 / (1.0 + math.exp(-value))


def fallback_tree_like(features):
    weighted = (
        float(features.get("priceChange24hPct", 0)) * 0.04
        + float(features.get("return3Pct", 0)) * 0.06
        + float(features.get("return12Pct", 0)) * 0.03
        + (float(features.get("volumeSpike", 1)) - 1) * 0.45
        + (float(features.get("buyRatioRecentPct", 50)) - 50) * 0.05
        + float(features.get("netBuyFlowUsd10m", 0)) / 15000.0
        + (float(features.get("sentimentScore", 0.5)) - 0.5) * 1.2
        - float(features.get("realizedVolPct", 0)) * 0.18
    )
    score = sigmoid(weighted)
    signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
    return {
        "score": score,
        "signal": signal,
        "confidence": abs(score - 0.5) * 2,
        "provider": "python_sidecar_fallback",
    }


def infer_model(payload):
    features = payload.get("features") or {}
    metadata = payload.get("metadata") or {}
    framework = str(metadata.get("framework") or payload.get("framework") or "").lower()
    artifact_path = metadata.get("artifactPath") or payload.get("artifactPath")
    deps = probe_dependencies()

    if framework == "xgboost":
        if artifact_path and Path(artifact_path).exists() and deps.get("xgboost"):
            import xgboost as xgb
            booster = xgb.Booster()
            booster.load_model(artifact_path)
            feature_order = metadata.get("featureOrder") or sorted(features.keys())
            vector = [[float(features.get(name, 0) or 0) for name in feature_order]]
            dmatrix = xgb.DMatrix(vector, feature_names=feature_order)
            score = float(booster.predict(dmatrix)[0])
            signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "xgboost"})
        emit({"ok": False, "code": "MODEL_ARTIFACT_UNAVAILABLE", "error": "xgboost artifact or runtime unavailable"})

    if framework == "lightgbm":
        if artifact_path and Path(artifact_path).exists() and deps.get("lightgbm"):
            import numpy as np
            import lightgbm as lgb
            booster = lgb.Booster(model_file=str(artifact_path))
            feature_order = metadata.get("featureOrder") or sorted(features.keys())
            vector = np.asarray([[float(features.get(name, 0) or 0) for name in feature_order]], dtype=float)
            score = float(booster.predict(vector)[0])
            signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "lightgbm"})
        emit({"ok": False, "code": "MODEL_ARTIFACT_UNAVAILABLE", "error": "LightGBM artifact or runtime unavailable"})

    if framework == "catboost":
        if artifact_path and Path(artifact_path).exists() and deps.get("catboost"):
            from catboost import CatBoostClassifier
            model = CatBoostClassifier()
            model.load_model(str(artifact_path))
            feature_order = metadata.get("featureOrder") or sorted(features.keys())
            vector = [[float(features.get(name, 0) or 0) for name in feature_order]]
            score = float(model.predict_proba(vector)[0][1])
            signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "catboost"})
        emit({"ok": False, "code": "MODEL_ARTIFACT_UNAVAILABLE", "error": "CatBoost artifact or runtime unavailable"})

    if framework in ("sklearn_random_forest", "sklearn"):
        if artifact_path and Path(artifact_path).exists() and deps.get("sklearn"):
            with open(artifact_path, "rb") as handle:
                model = pickle.load(handle)
            feature_order = metadata.get("featureOrder") or sorted(features.keys())
            vector = [[float(features.get(name, 0) or 0) for name in feature_order]]
            if hasattr(model, "predict_proba"):
                score = float(model.predict_proba(vector)[0][1])
            else:
                score = float(model.predict(vector)[0])
            signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "sklearn_random_forest"})
        emit({"ok": False, "code": "MODEL_ARTIFACT_UNAVAILABLE", "error": f"{framework} artifact or sklearn runtime unavailable"})

    if framework in ("torch_lstm", "lstm", "torch_gru", "gru", "pytorch"):
        if artifact_path and Path(artifact_path).exists() and deps.get("torch"):
            import torch
            artifact = torch.load(artifact_path, map_location="cpu")
            feature_order = artifact.get("feature_order") or metadata.get("featureOrder") or sorted(features.keys())
            hidden_size = int(artifact.get("hidden_size", 32))
            recurrent_type = artifact.get("recurrent_type") or ("gru" if framework in ("torch_gru", "gru") else "lstm")

            class PriceRecurrent(torch.nn.Module):
                def __init__(self, input_size, hidden_size):
                    super().__init__()
                    self.recurrent = torch.nn.GRU(input_size, hidden_size, batch_first=True) if recurrent_type == "gru" else torch.nn.LSTM(input_size, hidden_size, batch_first=True)
                    self.fc = torch.nn.Linear(hidden_size, 1)

                def forward(self, x):
                    output, _ = self.recurrent(x)
                    return self.fc(output[:, -1, :])

            model = PriceRecurrent(len(feature_order), hidden_size)
            model.load_state_dict(artifact["state_dict"])
            model.eval()
            vector = [float(features.get(name, 0) or 0) for name in feature_order]
            tensor = torch.tensor([[vector]], dtype=torch.float32)
            with torch.no_grad():
                logit = float(model(tensor).item())
            score = 1.0 / (1.0 + math.exp(-logit))
            signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": f"torch_{recurrent_type}"})
        emit({"ok": False, "code": "MODEL_ARTIFACT_UNAVAILABLE", "error": "torch recurrent artifact or torch runtime unavailable"})

    emit({"ok": True, **fallback_tree_like(features)})


def infer_model_batch(payload):
    rows = payload.get("rows") or []
    metadata = payload.get("metadata") or {}
    framework = str(metadata.get("framework") or payload.get("framework") or "").lower()
    artifact_path = metadata.get("artifactPath") or payload.get("artifactPath")
    feature_order = metadata.get("featureOrder") or payload.get("featureOrder") or []
    deps = probe_dependencies()
    if not rows:
        emit({"ok": True, "predictions": [], "provider": "empty_batch"})

    def vector_for(row):
        features = row.get("features") or row
        order = feature_order or sorted(features.keys())
        return [float(features.get(name, 0) or 0) for name in order]

    vectors = [vector_for(row) for row in rows]
    scores = None
    provider = framework or "fallback"

    if framework == "xgboost" and artifact_path and Path(artifact_path).exists() and deps.get("xgboost"):
        import xgboost as xgb
        booster = xgb.Booster()
        booster.load_model(artifact_path)
        dmatrix = xgb.DMatrix(vectors, feature_names=feature_order or None)
        scores = [float(value) for value in booster.predict(dmatrix)]
        provider = "xgboost"
    elif framework == "lightgbm" and artifact_path and Path(artifact_path).exists() and deps.get("lightgbm"):
        import numpy as np
        import lightgbm as lgb
        booster = lgb.Booster(model_file=str(artifact_path))
        scores = [float(value) for value in booster.predict(np.asarray(vectors, dtype=float))]
        provider = "lightgbm"
    elif framework == "catboost" and artifact_path and Path(artifact_path).exists() and deps.get("catboost"):
        from catboost import CatBoostClassifier
        model = CatBoostClassifier()
        model.load_model(str(artifact_path))
        scores = [float(value[1]) for value in model.predict_proba(vectors)]
        provider = "catboost"
    elif framework in ("sklearn_random_forest", "sklearn") and artifact_path and Path(artifact_path).exists() and deps.get("sklearn"):
        with open(artifact_path, "rb") as handle:
            model = pickle.load(handle)
        if hasattr(model, "predict_proba"):
            scores = [float(value[1]) for value in model.predict_proba(vectors)]
        else:
            scores = [float(value) for value in model.predict(vectors)]
        provider = "sklearn_random_forest"
    elif framework in ("torch_lstm", "lstm", "torch_gru", "gru", "pytorch") and artifact_path and Path(artifact_path).exists() and deps.get("torch"):
        import torch
        artifact = torch.load(artifact_path, map_location="cpu")
        feature_order = artifact.get("feature_order") or feature_order
        hidden_size = int(artifact.get("hidden_size", 32))
        recurrent_type = artifact.get("recurrent_type") or ("gru" if framework in ("torch_gru", "gru") else "lstm")
        vectors = [vector_for(row) for row in rows]

        class PriceRecurrent(torch.nn.Module):
            def __init__(self, input_size, hidden_size):
                super().__init__()
                self.recurrent = torch.nn.GRU(input_size, hidden_size, batch_first=True) if recurrent_type == "gru" else torch.nn.LSTM(input_size, hidden_size, batch_first=True)
                self.fc = torch.nn.Linear(hidden_size, 1)

            def forward(self, x):
                output, _ = self.recurrent(x)
                return self.fc(output[:, -1, :])

        model = PriceRecurrent(len(feature_order), hidden_size)
        model.load_state_dict(artifact["state_dict"])
        model.eval()
        tensor = torch.tensor([[row] for row in vectors], dtype=torch.float32)
        with torch.no_grad():
            logits = model(tensor).view(-1).tolist()
        scores = [1.0 / (1.0 + math.exp(-float(logit))) for logit in logits]
        provider = f"torch_{recurrent_type}"

    if scores is None:
        predictions = []
        for row in rows:
            result = fallback_tree_like(row.get("features") or row)
            predictions.append(result)
        emit({"ok": True, "predictions": predictions, "provider": "python_sidecar_fallback_batch"})

    predictions = []
    for score in scores:
        signal = "BUY" if score >= 0.64 else "SELL" if score <= 0.36 else "HOLD"
        predictions.append({
            "score": score,
            "signal": signal,
            "confidence": abs(score - 0.5) * 2,
            "provider": provider,
        })
    emit({"ok": True, "predictions": predictions, "provider": provider})


def simple_lexicon_score(texts):
    bullish = ["bullish", "breakout", "surge", "rally", "upgrade", "adoption", "recovery"]
    bearish = ["bearish", "hack", "exploit", "lawsuit", "fear", "dump", "crash"]
    total = 0
    for text in texts:
        lower = str(text or "").lower()
        for term in bullish:
            if term in lower:
                total += 1
        for term in bearish:
            if term in lower:
                total -= 1
    normalized = max(-1.0, min(1.0, total / max(1, len(texts) * 3)))
    score = max(0.0, min(1.0, 0.5 + normalized * 0.35))
    signal = "BUY" if score >= 0.58 else "SELL" if score <= 0.42 else "HOLD"
    return score, signal


def infer_sentiment(payload):
    texts = payload.get("texts") or []
    metadata = payload.get("metadata") or {}
    framework = str(metadata.get("framework") or payload.get("framework") or "").lower()
    deps = probe_dependencies()
    artifact_path = metadata.get("artifactPath") or payload.get("artifactPath")

    if framework == "finbert":
        if deps.get("transformers"):
            from transformers import AutoTokenizer, AutoModelForSequenceClassification
            import torch
            model_ref = artifact_path if artifact_path and Path(artifact_path).exists() else "ProsusAI/finbert"
            tokenizer = AutoTokenizer.from_pretrained(model_ref)
            model = AutoModelForSequenceClassification.from_pretrained(model_ref)
            text = " ".join([str(t) for t in texts[:16]])[:4000] or "neutral crypto market update"
            inputs = tokenizer(text, truncation=True, max_length=256, return_tensors="pt")
            with torch.no_grad():
              logits = model(**inputs).logits
              probs = torch.softmax(logits, dim=-1)[0].tolist()
            labels = ["positive", "negative", "neutral"] if len(probs) == 3 else [str(i) for i in range(len(probs))]
            mapped = dict(zip(labels, probs))
            positive = float(mapped.get("positive", probs[0] if probs else 0.33))
            negative = float(mapped.get("negative", probs[1] if len(probs) > 1 else 0.33))
            score = max(0.0, min(1.0, 0.5 + (positive - negative) * 0.45))
            signal = "BUY" if score >= 0.58 else "SELL" if score <= 0.42 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "finbert"})
        emit({"ok": False, "code": "SENTIMENT_MODEL_UNAVAILABLE", "error": "transformers/FinBERT runtime unavailable"})

    if framework == "vader":
        if deps.get("vaderSentiment"):
            from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
            analyzer = SentimentIntensityAnalyzer()
            text = " ".join([str(t) for t in texts[:32]])[:4000]
            compound = analyzer.polarity_scores(text or "neutral")["compound"]
            score = max(0.0, min(1.0, 0.5 + compound * 0.4))
            signal = "BUY" if score >= 0.58 else "SELL" if score <= 0.42 else "HOLD"
            emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "vader"})
        score, signal = simple_lexicon_score(texts)
        emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "vader_fallback"})

    score, signal = simple_lexicon_score(texts)
    emit({"ok": True, "score": score, "signal": signal, "confidence": abs(score - 0.5) * 2, "provider": "python_custom_sentiment"})


def train_model(payload):
    deps = probe_dependencies()
    framework = str((payload.get("framework") or "")).lower()
    artifact_path = Path(payload.get("artifactPath") or "")
    rows = payload.get("rows") or []
    feature_order = payload.get("featureOrder") or []
    if not rows or not feature_order:
        emit({"ok": False, "code": "TRAINING_DATA_UNAVAILABLE", "error": "rows and featureOrder are required"})

    if framework == "xgboost":
        if not deps.get("xgboost"):
            emit({"ok": False, "code": "TRAINING_RUNTIME_UNAVAILABLE", "error": "xgboost is not installed"})
        import xgboost as xgb
        x = [[float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order] for row in rows]
        y = [int(bool(row.get("label"))) for row in rows]
        dtrain = xgb.DMatrix(x, label=y, feature_names=feature_order)
        params = {
            "objective": "binary:logistic",
            "eval_metric": "logloss",
            "max_depth": 4,
            "eta": 0.08,
            "subsample": 0.9,
            "colsample_bytree": 0.9,
            "seed": 42,
        }
        booster = xgb.train(params, dtrain, num_boost_round=80)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        booster.save_model(artifact_path)
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": framework, "trainedRows": len(rows)})

    if framework == "lightgbm":
        if not deps.get("lightgbm"):
            emit({"ok": False, "code": "TRAINING_RUNTIME_UNAVAILABLE", "error": "lightgbm is not installed"})
        import numpy as np
        import lightgbm as lgb
        x = [[float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order] for row in rows]
        y = [int(bool(row.get("label"))) for row in rows]
        train = lgb.Dataset(np.asarray(x, dtype=float), label=np.asarray(y, dtype=int), feature_name=feature_order)
        params = {"objective": "binary", "metric": "binary_logloss", "learning_rate": 0.05, "num_leaves": 16, "seed": 42, "verbosity": -1}
        model = lgb.train(params, train, num_boost_round=80)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        model.save_model(str(artifact_path))
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": framework, "trainedRows": len(rows)})

    if framework == "catboost":
        if not deps.get("catboost"):
            emit({"ok": False, "code": "TRAINING_RUNTIME_UNAVAILABLE", "error": "catboost is not installed"})
        from catboost import CatBoostClassifier
        x = [[float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order] for row in rows]
        y = [int(bool(row.get("label"))) for row in rows]
        model = CatBoostClassifier(iterations=80, depth=4, learning_rate=0.05, loss_function="Logloss", verbose=False, random_seed=42)
        model.fit(x, y)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        model.save_model(str(artifact_path))
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": framework, "trainedRows": len(rows)})

    if framework in ("sklearn_random_forest", "sklearn"):
        if not deps.get("sklearn"):
            emit({"ok": False, "code": "TRAINING_RUNTIME_UNAVAILABLE", "error": "scikit-learn is not installed"})
        from sklearn.ensemble import RandomForestClassifier
        x = [[float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order] for row in rows]
        y = [int(bool(row.get("label"))) for row in rows]
        model = RandomForestClassifier(n_estimators=128, max_depth=8, random_state=42)
        model.fit(x, y)
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        with open(artifact_path, "wb") as handle:
            pickle.dump(model, handle)
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": framework, "trainedRows": len(rows)})

    if framework in ("torch_lstm", "lstm", "torch_gru", "gru", "pytorch"):
        if not deps.get("torch"):
            emit({"ok": False, "code": "TRAINING_RUNTIME_UNAVAILABLE", "error": "torch is not installed"})
        import torch

        recurrent_type = "gru" if framework in ("torch_gru", "gru") else "lstm"

        class PriceRecurrent(torch.nn.Module):
            def __init__(self, input_size, hidden_size):
                super().__init__()
                self.recurrent = torch.nn.GRU(input_size, hidden_size, batch_first=True) if recurrent_type == "gru" else torch.nn.LSTM(input_size, hidden_size, batch_first=True)
                self.fc = torch.nn.Linear(hidden_size, 1)

            def forward(self, x):
                output, _ = self.recurrent(x)
                return self.fc(output[:, -1, :])

        x = [[float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order] for row in rows]
        y = [float(int(bool(row.get("label")))) for row in rows]
        tensor_x = torch.tensor([[row] for row in x], dtype=torch.float32)
        tensor_y = torch.tensor(y, dtype=torch.float32).view(-1, 1)
        model = PriceRecurrent(len(feature_order), 32)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.01)
        loss_fn = torch.nn.BCEWithLogitsLoss()
        model.train()
        for _ in range(18):
            optimizer.zero_grad()
            logits = model(tensor_x)
            loss = loss_fn(logits, tensor_y)
            loss.backward()
            optimizer.step()
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "state_dict": model.state_dict(),
            "feature_order": feature_order,
            "hidden_size": 32,
            "recurrent_type": recurrent_type,
        }, artifact_path)
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": framework, "trainedRows": len(rows)})

    emit({"ok": False, "code": "TRAINING_NOT_IMPLEMENTED", "error": f"Training not implemented for {framework or 'unknown'}"})


def train_regime_model(payload):
    deps = probe_dependencies()
    framework = str((payload.get("framework") or "")).lower()
    artifact_path = Path(payload.get("artifactPath") or "")
    rows = payload.get("rows") or []
    feature_order = payload.get("featureOrder") or []
    if not rows or not feature_order:
        emit({"ok": False, "code": "TRAINING_DATA_UNAVAILABLE", "error": "rows and featureOrder are required"})
    if not deps.get("sklearn"):
        emit({"ok": False, "code": "TRAINING_RUNTIME_UNAVAILABLE", "error": "scikit-learn is required for regime models"})

    x = [[float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order] for row in rows]
    artifact = {"framework": framework, "feature_order": feature_order}

    if framework == "kmeans":
        from sklearn.cluster import KMeans
        model = KMeans(n_clusters=int(payload.get("nClusters") or 4), random_state=42, n_init=10)
        model.fit(x)
        artifact["model"] = model
    elif framework in ("gmm", "gaussian_mixture"):
        from sklearn.mixture import GaussianMixture
        model = GaussianMixture(n_components=int(payload.get("nClusters") or 4), covariance_type="full", random_state=42)
        model.fit(x)
        artifact["model"] = model
    elif framework in ("hmm", "gaussian_hmm"):
        if deps.get("hmmlearn"):
            from hmmlearn.hmm import GaussianHMM
            model = GaussianHMM(n_components=int(payload.get("nClusters") or 4), covariance_type="diag", n_iter=100, random_state=42)
            model.fit(x)
            artifact["model"] = model
            artifact["framework"] = "hmmlearn_gaussian_hmm"
        else:
            from sklearn.mixture import GaussianMixture
            model = GaussianMixture(n_components=int(payload.get("nClusters") or 4), covariance_type="diag", random_state=42)
            model.fit(x)
            artifact["model"] = model
            artifact["framework"] = "hmm_fallback_gmm"
    else:
        emit({"ok": False, "code": "REGIME_TRAINING_NOT_IMPLEMENTED", "error": f"Unsupported regime framework {framework}"})

    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    with open(artifact_path, "wb") as handle:
        pickle.dump(artifact, handle)
    emit({"ok": True, "artifactPath": str(artifact_path), "framework": artifact["framework"], "trainedRows": len(rows)})


def infer_regime_model(payload):
    metadata = payload.get("metadata") or {}
    artifact_path = metadata.get("artifactPath") or payload.get("artifactPath")
    features = payload.get("features") or {}
    if not artifact_path or not Path(artifact_path).exists():
        emit({"ok": False, "code": "REGIME_ARTIFACT_UNAVAILABLE", "error": "regime artifact unavailable"})
    with open(artifact_path, "rb") as handle:
        artifact = pickle.load(handle)
    feature_order = artifact.get("feature_order") or sorted(features.keys())
    vector = [[float(features.get(name, 0) or 0) for name in feature_order]]
    model = artifact["model"]
    if hasattr(model, "predict_proba"):
        probs = model.predict_proba(vector)[0].tolist()
        label_index = int(max(range(len(probs)), key=lambda i: probs[i]))
        confidence = float(probs[label_index])
    elif hasattr(model, "predict"):
        label_index = int(model.predict(vector)[0])
        confidence = 0.5
    else:
        label_index = 0
        confidence = 0.0
    labels = payload.get("labels") or ["risk_on", "breakout", "ranging", "risk_off"]
    label = labels[label_index % len(labels)]
    emit({"ok": True, "label": label, "confidence": confidence, "cluster": label_index, "provider": artifact.get("framework", "regime_model")})


def cache_sentiment_model(payload):
    framework = str((payload.get("framework") or "")).lower()
    artifact_path = Path(payload.get("artifactPath") or "")
    deps = probe_dependencies()
    artifact_path.parent.mkdir(parents=True, exist_ok=True)

    if framework == "finbert":
        if not deps.get("transformers"):
            emit({"ok": False, "code": "SENTIMENT_MODEL_UNAVAILABLE", "error": "transformers is not installed"})
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        model_ref = payload.get("modelName") or "ProsusAI/finbert"
        tokenizer = AutoTokenizer.from_pretrained(model_ref)
        model = AutoModelForSequenceClassification.from_pretrained(model_ref)
        tokenizer.save_pretrained(artifact_path)
        model.save_pretrained(artifact_path)
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": "finbert"})

    if framework == "vader":
        artifact_path.mkdir(parents=True, exist_ok=True)
        with open(artifact_path / "vader.json", "w", encoding="utf8") as handle:
            json.dump({"framework": "vader", "ready": True}, handle)
        emit({"ok": True, "artifactPath": str(artifact_path), "framework": "vader"})

    emit({"ok": False, "code": "SENTIMENT_CACHE_NOT_IMPLEMENTED", "error": f"Unsupported sentiment framework {framework}"})


def infer_rl(payload):
    deps = probe_dependencies()
    metadata = payload.get("metadata") or {}
    artifact_path = metadata.get("artifactPath") or payload.get("artifactPath")
    framework = str(metadata.get("framework") or payload.get("framework") or "sb3").lower()
    features = payload.get("features") or {}
    if framework == "sb3":
        if artifact_path and Path(artifact_path).exists() and deps.get("stable_baselines3"):
            from stable_baselines3 import PPO
            import numpy as np
            model = PPO.load(artifact_path)
            feature_order = metadata.get("featureOrder") or sorted(features.keys())
            obs = np.array([float(features.get(name, 0) or 0) for name in feature_order], dtype=np.float32)
            action, _ = model.predict(obs, deterministic=True)
            if int(action) == 1:
                emit({"ok": True, "signal": "BUY", "score": 0.72, "confidence": 0.44, "provider": "sb3"})
            if int(action) == 2:
                emit({"ok": True, "signal": "SELL", "score": 0.28, "confidence": 0.44, "provider": "sb3"})
            emit({"ok": True, "signal": "HOLD", "score": 0.5, "confidence": 0.1, "provider": "sb3"})
        emit({"ok": False, "code": "RL_ARTIFACT_UNAVAILABLE", "error": "SB3 artifact or runtime unavailable"})

    if framework == "rllib":
        if artifact_path and Path(artifact_path).exists() and deps.get("ray"):
            import numpy as np
            from ray.rllib.algorithms.algorithm import Algorithm
            algo = Algorithm.from_checkpoint(artifact_path)
            feature_order = metadata.get("featureOrder") or sorted(features.keys())
            obs = np.array([float(features.get(name, 0) or 0) for name in feature_order], dtype=np.float32)
            action = int(algo.compute_single_action(obs))
            if action == 1:
                emit({"ok": True, "signal": "BUY", "score": 0.72, "confidence": 0.44, "provider": "rllib"})
            if action == 2:
                emit({"ok": True, "signal": "SELL", "score": 0.28, "confidence": 0.44, "provider": "rllib"})
            emit({"ok": True, "signal": "HOLD", "score": 0.5, "confidence": 0.1, "provider": "rllib"})
        emit({"ok": False, "code": "RL_ARTIFACT_UNAVAILABLE", "error": "RLlib artifact or runtime unavailable"})

    emit({"ok": False, "code": "RL_INFERENCE_NOT_IMPLEMENTED", "error": f"Unsupported RL framework {framework}"})


def train_rl(payload):
    deps = probe_dependencies()
    engine = str(payload.get("engine") or "sb3").lower()
    artifact_path = Path(payload.get("artifactPath") or "")
    feature_order = payload.get("featureOrder") or []
    episodes = int(payload.get("episodes") or 2000)
    rows = payload.get("rows") or []

    if engine == "sb3":
        if not deps.get("stable_baselines3"):
            emit({"ok": False, "code": "RL_RUNTIME_UNAVAILABLE", "error": "stable-baselines3 is not installed"})
        if not rows or not feature_order:
            emit({"ok": False, "code": "TRAINING_DATA_UNAVAILABLE", "error": "rows and featureOrder are required for SB3 training"})
        import gymnasium as gym
        import numpy as np
        from stable_baselines3 import PPO

        observations = [np.array([float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order], dtype=np.float32) for row in rows]
        rewards = [1.0 if row.get("label") else -1.0 for row in rows]

        class SequenceEnv(gym.Env):
            metadata = {"render.modes": []}

            def __init__(self):
                self.observation_space = gym.spaces.Box(low=-1e6, high=1e6, shape=(len(feature_order),), dtype=np.float32)
                self.action_space = gym.spaces.Discrete(3)  # hold, buy, sell
                self.index = 0

            def reset(self, *, seed=None, options=None):
                super().reset(seed=seed)
                self.index = 0
                return observations[self.index], {}

            def step(self, action):
                reward = 0.05 if int(action) == 0 else rewards[self.index] if int(action) == 1 else (-rewards[self.index] * 0.5)
                self.index += 1
                terminated = self.index >= len(observations)
                obs = observations[min(self.index, len(observations) - 1)]
                return obs, float(reward), terminated, False, {}

        env = SequenceEnv()
        model = PPO("MlpPolicy", env, verbose=0, n_steps=min(256, max(32, len(observations))), batch_size=min(64, max(16, len(observations) // 4 or 16)))
        model.learn(total_timesteps=max(512, episodes))
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        model.save(artifact_path)
        emit({
            "ok": True,
            "artifactPath": str(artifact_path),
            "framework": "sb3",
            "trainedRows": len(rows),
            "metrics": {
                "trainingEpisodes": episodes,
                "featureOrder": feature_order,
            },
        })

    if engine == "rllib":
        if not deps.get("ray"):
            emit({"ok": False, "code": "RL_RUNTIME_UNAVAILABLE", "error": "ray[rllib] is not installed"})
        import gymnasium as gym
        import numpy as np
        import ray
        from ray.tune.registry import register_env
        from ray.rllib.algorithms.ppo import PPOConfig

        observations = [np.array([float((row.get("features") or {}).get(name, 0) or 0) for name in feature_order], dtype=np.float32) for row in rows]
        rewards = [1.0 if row.get("label") else -1.0 for row in rows]

        class SequenceEnv(gym.Env):
            metadata = {"render.modes": []}

            def __init__(self, config=None):
                self.observation_space = gym.spaces.Box(low=-1e6, high=1e6, shape=(len(feature_order),), dtype=np.float32)
                self.action_space = gym.spaces.Discrete(3)
                self.index = 0

            def reset(self, *, seed=None, options=None):
                super().reset(seed=seed)
                self.index = 0
                return observations[self.index], {}

            def step(self, action):
                reward = 0.05 if int(action) == 0 else rewards[self.index] if int(action) == 1 else (-rewards[self.index] * 0.5)
                self.index += 1
                terminated = self.index >= len(observations)
                obs = observations[min(self.index, len(observations) - 1)]
                return obs, float(reward), terminated, False, {}

        env_name = "DexTradingSequenceEnv"
        register_env(env_name, lambda cfg: SequenceEnv(cfg))
        ray.init(ignore_reinit_error=True, include_dashboard=False, local_mode=True)
        algo = (
            PPOConfig()
            .environment(env_name)
            .env_runners(num_env_runners=0)
            .framework("torch")
            .training(train_batch_size=max(64, min(1024, len(observations)))))
        algo = algo.build()
        iterations = max(1, int(episodes / 250))
        for _ in range(iterations):
            algo.train()
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint_dir = algo.save_to_path(str(artifact_path))
        ray.shutdown()
        emit({
            "ok": True,
            "artifactPath": str(checkpoint_dir),
            "framework": "rllib",
            "trainedRows": len(rows),
            "metrics": {
                "trainingEpisodes": episodes,
                "featureOrder": feature_order,
            },
        })

    emit({"ok": False, "code": "RL_TRAINING_NOT_IMPLEMENTED", "error": f"Unknown RL engine {engine}"})


def health():
    emit({"ok": True, "dependencies": probe_dependencies(), "cwd": os.getcwd()})


def main():
    command = str(sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    payload = load_payload() if command not in ("health", "") else {}
    if command == "health":
        health()
    elif command == "infer_model":
        infer_model(payload)
    elif command == "infer_model_batch":
        infer_model_batch(payload)
    elif command == "infer_sentiment":
        infer_sentiment(payload)
    elif command == "train_model":
        train_model(payload)
    elif command == "train_regime_model":
        train_regime_model(payload)
    elif command == "infer_regime_model":
        infer_regime_model(payload)
    elif command == "cache_sentiment_model":
        cache_sentiment_model(payload)
    elif command == "infer_rl":
        infer_rl(payload)
    elif command == "train_rl":
        train_rl(payload)
    else:
        emit({"ok": False, "error": f"Unknown command: {command}", "code": "UNKNOWN_COMMAND"}, 1)


if __name__ == "__main__":
    main()
