import csv
import json
import sys
from pathlib import Path


def load_payload():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python scripts/run-backtrader-backtest.py <dataset.json> [out.json]")
    dataset_path = Path(sys.argv[1]).resolve()
    out_path = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else dataset_path.with_name(dataset_path.stem + "-backtrader-result.json")
    data = json.loads(dataset_path.read_text(encoding="utf-8"))
    rows = list(data.get("rows") or [])
    if len(rows) < 30:
        raise SystemExit("Need at least 30 OHLCV rows for Backtrader export")
    return dataset_path, out_path, rows, data


def run_fallback_backtest(rows):
    cash = 10_000.0
    qty = 0.0
    entry_price = 0.0
    trades = []
    closes = [float(row.get("close", 0) or 0) for row in rows]
    volumes = [float(row.get("volume", 0) or 0) for row in rows]

    for idx in range(20, len(rows)):
        close = closes[idx]
        if close <= 0:
            continue
        ema_fast = sum(closes[max(0, idx - 7): idx + 1]) / min(8, idx + 1)
        ema_slow = sum(closes[max(0, idx - 20): idx + 1]) / min(21, idx + 1)
        avg_volume = sum(volumes[max(0, idx - 19): idx + 1]) / min(20, idx + 1)
        volume_spike = volumes[idx] / avg_volume if avg_volume > 0 else 1.0

        if qty == 0 and ema_fast > ema_slow and volume_spike >= 1.15:
            spend = cash * 0.10
            qty = spend / close
            cash -= spend
            entry_price = close
            trades.append({"side": "BUY", "timestamp": rows[idx].get("timestamp"), "price": close, "qty": qty})
            continue

        pnl_pct = ((close - entry_price) / entry_price) * 100 if entry_price > 0 else 0
        if qty > 0 and (ema_fast < ema_slow or pnl_pct >= 8 or pnl_pct <= -4):
            cash += qty * close
            trades.append({"side": "SELL", "timestamp": rows[idx].get("timestamp"), "price": close, "qty": qty, "pnlPct": pnl_pct})
            qty = 0.0
            entry_price = 0.0

    final_close = closes[-1]
    equity = cash + (qty * final_close if qty > 0 else 0)
    return {
        "engine": "fallback_python",
        "startingCash": 10_000.0,
        "endingEquity": equity,
        "openPositionQty": qty,
        "tradeCount": len(trades),
        "trades": trades[-25:],
        "totalReturnPct": ((equity - 10_000.0) / 10_000.0) * 100,
    }


def maybe_run_backtrader(rows):
    try:
        import backtrader as bt  # type: ignore
    except Exception:
        return None

    csv_path = Path.cwd() / "artifacts" / "backtrader" / "_bt_tmp.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["datetime", "open", "high", "low", "close", "volume"])
        for row in rows:
            writer.writerow([
                row.get("timestamp"),
                row.get("open"),
                row.get("high"),
                row.get("low"),
                row.get("close"),
                row.get("volume"),
            ])

    class MomentumStrategy(bt.Strategy):
        params = dict()

        def __init__(self):
            self.ema_fast = bt.ind.EMA(period=8)
            self.ema_slow = bt.ind.EMA(period=21)
            self.volume_sma = bt.ind.SMA(self.data.volume, period=20)

        def next(self):
            if not self.position:
                if self.ema_fast[0] > self.ema_slow[0] and self.volume_sma[0] and self.data.volume[0] >= (self.volume_sma[0] * 1.15):
                    size = max(1, int((self.broker.getcash() * 0.10) / max(self.data.close[0], 0.0000001)))
                    self.buy(size=size)
            else:
                pnl_pct = ((self.data.close[0] - self.position.price) / self.position.price) * 100 if self.position.price else 0
                if self.ema_fast[0] < self.ema_slow[0] or pnl_pct >= 8 or pnl_pct <= -4:
                    self.close()

    class CsvData(bt.feeds.GenericCSVData):
        params = (
            ("dtformat", "%s"),
            ("datetime", 0),
            ("open", 1),
            ("high", 2),
            ("low", 3),
            ("close", 4),
            ("volume", 5),
            ("openinterest", -1),
        )

    cerebro = bt.Cerebro()
    cerebro.broker.setcash(10_000.0)
    cerebro.addstrategy(MomentumStrategy)
    cerebro.adddata(CsvData(dataname=str(csv_path)))
    cerebro.run()
    return {
        "engine": "backtrader",
        "startingCash": 10_000.0,
        "endingEquity": cerebro.broker.getvalue(),
        "tradeCount": None,
        "totalReturnPct": ((cerebro.broker.getvalue() - 10_000.0) / 10_000.0) * 100,
    }


def main():
    dataset_path, out_path, rows, metadata = load_payload()
    result = maybe_run_backtrader(rows) or run_fallback_backtest(rows)
    payload = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "datasetPath": str(dataset_path),
        "chainKey": metadata.get("chainKey"),
        "symbol": metadata.get("symbol"),
        "interval": metadata.get("interval"),
        **result,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps({"outPath": str(out_path), "engine": payload["engine"], "totalReturnPct": payload["totalReturnPct"]}))


if __name__ == "__main__":
    main()
