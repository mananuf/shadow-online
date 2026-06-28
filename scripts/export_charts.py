#!/usr/bin/env python3
"""Export the lean-shadow-fuzzer Observatory charts to static PNGs.

The Observatory renders interactive Plotly figures from a run's stats.json; it
keeps no standalone images. This script rebuilds the key figures from the same
stats.json fields and writes PNGs (via kaleido) so the guidebook can embed them.

The plotting mirrors lean-shadow-fuzzer/notebooks/analysis.ipynb. Each chart is
written defensively: missing data prints a skip notice instead of failing.

Usage:
    uv run --with kaleido --with networkx python export_charts.py <run-dir> <out-dir>
"""

from __future__ import annotations

import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots


def load_json(p: Path) -> dict:
    return json.loads(p.read_text()) if p.is_file() else {}


def save(fig, out: Path, name: str, height: int = 450) -> None:
    fig.update_layout(height=height, template="plotly_white")
    path = out / name
    fig.write_image(str(path), scale=2, width=1100, height=height)
    print(f"  wrote {path.name}")


def main() -> None:
    run_dir = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    meta = load_json(run_dir / "run-metadata.json")
    stats = load_json(run_dir / "stats.json")
    regions = load_json(run_dir / "regions.json")
    bandwidths = load_json(run_dir / "bandwidths.json")
    run_id = meta.get("run_id", run_dir.name)
    node_counts = stats.get("node_counts") or meta.get("node_counts") or {}

    print(f"Exporting charts for {run_id} -> {out}")

    # §1 Client distribution -------------------------------------------------
    if node_counts:
        fig = px.pie(
            names=list(node_counts.keys()), values=list(node_counts.values()),
            title=f"Client Distribution ({sum(node_counts.values())} nodes)", hole=0.4,
        )
        fig.update_traces(textposition="inside", textinfo="percent+label+value")
        save(fig, out, "client_distribution.png", 420)

    # §1 Region + bandwidth tier distribution --------------------------------
    region_counts = Counter(regions.values()) if regions else Counter()
    bw_counts = Counter(bandwidths.values()) if bandwidths else Counter()
    if region_counts or bw_counts:
        fig = make_subplots(rows=1, cols=2, subplot_titles=("Region Distribution", "Bandwidth Tier Distribution"))
        if region_counts:
            fig.add_bar(x=list(region_counts.keys()), y=list(region_counts.values()), marker_color="steelblue", row=1, col=1)
        if bw_counts:
            fig.add_bar(x=list(bw_counts.keys()), y=list(bw_counts.values()), marker_color="coral", row=1, col=2)
        fig.update_layout(showlegend=False, title="Node Geography & Link Tiers")
        save(fig, out, "region_bandwidth_distribution.png", 400)

    # §1 Gossipsub bandwidth per node by topic (aggregator vs not) -----------
    try:
        import yaml
        vc = yaml.safe_load((run_dir / "genesis" / "validator-config.yaml").read_text())
        agg_hosts = {v["name"].replace("_", "-") for v in vc.get("validators", []) if v.get("isAggregator")}
        non_hosts = {v["name"].replace("_", "-") for v in vc.get("validators", []) if not v.get("isAggregator")}
        bw_slots = stats.get("bandwidth", {}).get("slots", [])
        TOPIC = {"aggregation", "attestation", "block"}
        totals: dict = defaultdict(int)
        for s in bw_slots:
            if s.get("protocol") != "gossip" or s.get("message_kind") not in TOPIC:
                continue
            totals[(s["message_kind"], s.get("host", "") in agg_hosts, s.get("direction", "?"))] += s["bytes"]
        rows = []
        for kind in sorted(TOPIC):
            for role, members in (("Aggregator", agg_hosts), ("Non-aggregator", non_hosts)):
                n = len(members)
                is_agg = role == "Aggregator"
                rows.append({"Topic": kind, "Role": role,
                             "Avg inbound per node (MiB)": totals.get((kind, is_agg, "in"), 0) / n / 1e6 if n else 0})
        if any(r["Avg inbound per node (MiB)"] for r in rows):
            fig = px.bar(pd.DataFrame(rows), x="Topic", y="Avg inbound per node (MiB)", color="Role",
                         barmode="group", title="Avg Gossipsub Inbound per Node by Topic", text_auto=".2f")
            save(fig, out, "gossipsub_bandwidth_by_topic.png", 430)
        else:
            print("  skip gossipsub_bandwidth_by_topic (no bandwidth events)")
    except Exception as e:  # noqa: BLE001
        print(f"  skip gossipsub_bandwidth_by_topic ({e})")

    # §2 Block propagation latency + percentiles + size ----------------------
    block_slots = stats.get("blocks", {}).get("slots", [])
    rows = []
    for s in block_slots:
        pub = s.get("published_ms")
        if pub is None:
            continue
        for host, recv in s.get("receive_timestamps_ms", {}).items():
            rows.append({"slot": s["slot"], "host": host,
                         "client": host.rsplit("-", 1)[0] if "-" in host else host,
                         "latency_ms": round(recv - pub, 1)})
    if rows:
        df = pd.DataFrame(rows)
        n_hosts = df["host"].nunique()
        fig = px.scatter(df, x="slot", y="latency_ms", color="client" if n_hosts > 20 else "host",
                         title="Block Propagation Latency (publish → receive)",
                         labels={"latency_ms": "Latency (ms)", "slot": "Slot"})
        save(fig, out, "block_propagation_latency.png", 500)

        dfp = (df.groupby("slot")["latency_ms"].quantile([0.5, 0.95, 0.99]).unstack()
               .rename(columns={0.5: "p50", 0.95: "p95", 0.99: "p99"}).reset_index())
        fig = go.Figure()
        for col in ["p50", "p95", "p99"]:
            fig.add_scatter(x=dfp["slot"], y=dfp[col], mode="lines+markers", name=col)
        fig.update_layout(title="Block Propagation Latency Percentiles per Slot",
                          xaxis_title="Slot", yaxis_title="Latency (ms)")
        save(fig, out, "block_propagation_percentiles.png", 430)
    else:
        print("  skip block propagation (no block events)")

    sizes = [{"slot": s["slot"], "kib": s["block_size_bytes"] / 1024} for s in block_slots if "block_size_bytes" in s]
    if sizes:
        fig = px.line(pd.DataFrame(sizes), x="slot", y="kib", markers=True,
                      title="Block Size per Slot", labels={"kib": "Block size (KiB)", "slot": "Slot"})
        save(fig, out, "block_size_per_slot.png", 380)

    # §3 Attestation coverage + CDFs -----------------------------------------
    attestations = stats.get("attestations", {})
    cov = attestations.get("coverage", {}).get("slots", []) if isinstance(attestations.get("coverage"), dict) else attestations.get("coverage", [])
    if cov:
        dfc = pd.DataFrame(cov)
        fig = go.Figure()
        for field, name, color, dash in [
            ("p50_nodes_to_95_attestations_ms", "p50 node latency", "royalblue", "solid"),
            ("p90_nodes_to_95_attestations_ms", "p90 node latency", "darkorange", "dash"),
            ("p95_nodes_to_95_attestations_ms", "p95 node latency", "coral", "dot")]:
            if field in dfc.columns:
                fig.add_scatter(x=dfc["slot"], y=dfc[field], mode="lines+markers", name=name, line=dict(color=color, dash=dash))
        fig.update_layout(title="Time for Nodes to Reach 95% Attestation Coverage per Slot",
                          xaxis_title="Slot", yaxis_title="Latency (ms)")
        save(fig, out, "attestation_coverage.png", 430)
    else:
        print("  skip attestation_coverage (no coverage data)")

    def cdf_chart(items, key_slot, title, name, label):
        if not items:
            print(f"  skip {name} (no data)")
            return
        rng = random.Random(str(run_id) + name)
        pick = rng.choice(items)
        times = sorted(pick["propagation_times_ms"])
        n = len(times)
        y = [(i + 1) / n for i in range(n)]
        fig = go.Figure()
        fig.add_scatter(x=times, y=y, mode="lines", line_shape="hv")
        fig.update_layout(title=title.format(**{key_slot: pick.get(key_slot)}),
                          xaxis_title="Propagation time (ms)", yaxis_title="CDF",
                          yaxis=dict(range=[0, 1]), showlegend=False)
        save(fig, out, name, 430)

    cdf_chart(attestations.get("validator_propagation", []), "slot",
              "Attestation Propagation CDF — one validator (slot {slot})",
              "attestation_validator_cdf.png", "")
    cdf_chart(attestations.get("aggregation_propagation", []), "slot",
              "Aggregated Attestation Propagation CDF — slot {slot}",
              "aggregated_attestation_cdf.png", "")

    # §4 Finality heatmaps ---------------------------------------------------
    chain_slots = stats.get("chain_status", {}).get("slots", [])
    if chain_slots:
        def hkey(h):
            p, sep, suf = h.rpartition("-")
            return (p, int(suf)) if sep and suf.isdigit() else (h, -1)
        hosts = sorted({h for s in chain_slots for h in s.get("hosts", {})}, key=hkey)
        for metric, key, scale, title, fname in [
            ("head", "head_slot", "Blues", "Chain Head Slot per Node", "finality_head_heatmap.png"),
            ("finalized", "latest_finalized_slot", "Greens", "Finalized Slot per Node", "finality_finalized_heatmap.png")]:
            rows = [{"slot": s["slot"], "host": h, metric: s.get("hosts", {}).get(h, {}).get(key, 0)}
                    for s in chain_slots for h in hosts]
            pivot = pd.DataFrame(rows).pivot(index="host", columns="slot", values=metric).reindex(hosts)
            fig = go.Figure(go.Heatmap(z=pivot.values.tolist(), x=[str(c) for c in pivot.columns],
                                       y=list(pivot.index), colorscale=scale, colorbar=dict(title="slot")))
            fig.update_layout(title=title, xaxis_title="Slot", yaxis_title="Node")
            save(fig, out, fname, max(360, len(hosts) * 26))
    else:
        print("  skip finality heatmaps (no chain status)")

    # §5 Topology ------------------------------------------------------------
    topo = run_dir / "topology.gml"
    if topo.exists():
        try:
            import networkx as nx
            G = nx.read_gml(topo)
            pos = nx.spring_layout(G, seed=42)
            ex, ey = [], []
            for u, v in G.edges():
                ex += [pos[u][0], pos[v][0], None]
                ey += [pos[u][1], pos[v][1], None]
            node_regions = [regions.get(str(n), "unknown") for n in G.nodes()]
            labels = sorted(set(node_regions))
            ids = {r: i for i, r in enumerate(labels)}
            fig = go.Figure()
            fig.add_scatter(x=ex, y=ey, mode="lines", line=dict(width=0.5, color="#888"), hoverinfo="none")
            fig.add_scatter(x=[pos[n][0] for n in G.nodes()], y=[pos[n][1] for n in G.nodes()], mode="markers",
                            marker=dict(size=9, color=[ids[r] for r in node_regions], colorscale="Viridis",
                                        showscale=True, colorbar=dict(tickmode="array", tickvals=list(ids.values()), ticktext=labels)),
                            text=[f"{n} ({r})" for n, r in zip(G.nodes(), node_regions)], hoverinfo="text")
            fig.update_layout(title=f"Underlay Network Topology ({G.number_of_nodes()} nodes, {G.number_of_edges()} edges)",
                              showlegend=False, xaxis=dict(visible=False), yaxis=dict(visible=False))
            save(fig, out, "topology.png", 560)
        except Exception as e:  # noqa: BLE001
            print(f"  skip topology ({e})")

    print("done.")


if __name__ == "__main__":
    main()
