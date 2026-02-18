(function () {
  const rootData = window.DDR5_DATA;
  const chartCanvas = document.getElementById("priceChart");
  const generatedMeta = document.getElementById("generatedMeta");
  const summaryRows = document.getElementById("summaryRows");
  const sourceList = document.getElementById("sourceList");
  const exportButton = document.getElementById("exportCsv");

  if (!rootData || !chartCanvas) {
    return;
  }

  if (typeof Chart === "undefined") {
    chartCanvas.replaceWith(document.createTextNode("Chart library failed to load. Check internet access for the CDN script."));
    return;
  }

  const capacities = rootData.capacitiesGb;
  const historical = rootData.series.historical;
  const projection = rootData.series.projection;
  const allMonths = historical.map((r) => r.month).concat(projection.map((r) => r.month));
  const observedStart = rootData.historicalWindow.observedIndexStart;

  const colors = {
    16: "#32d7b8",
    32: "#ff9f45",
    64: "#6ec6ff",
  };

  const state = {
    capacityEnabled: { 16: true, 32: true, 64: true },
    viewMode: "both",
  };

  const money = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0,
  });

  const moneyPrecise = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 2,
  });

  function fmtMonth(ym) {
    const [y, m] = ym.split("-");
    const dt = new Date(Number(y), Number(m) - 1, 1);
    return dt.toLocaleDateString("en-CA", { month: "short", year: "numeric" });
  }

  function fmtDelta(value) {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}%`;
  }

  function buildDatasets() {
    const histCount = historical.length;
    const datasets = [];

    capacities.forEach((cap) => {
      const histSeries = historical.map((r) => r[`gb${cap}`]);
      const projSeries = new Array(histCount).fill(null).concat(projection.map((r) => r[`gb${cap}`]));

      datasets.push({
        label: `${cap}GB Historical`,
        phase: "historical",
        capacity: cap,
        data: histSeries,
        borderColor: colors[cap],
        backgroundColor: colors[cap],
        borderWidth: 2.6,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.24,
      });

      datasets.push({
        label: `${cap}GB Projected`,
        phase: "projection",
        capacity: cap,
        data: projSeries,
        borderColor: colors[cap],
        backgroundColor: colors[cap],
        borderDash: [7, 6],
        borderWidth: 1.9,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.24,
      });
    });

    return datasets;
  }

  const observedMarkerPlugin = {
    id: "observedMarker",
    afterDraw(chart) {
      const markerIndex = allMonths.indexOf(observedStart);
      if (markerIndex < 0) {
        return;
      }

      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      if (!xScale || !yScale) {
        return;
      }

      const x = xScale.getPixelForValue(markerIndex);
      const ctx = chart.ctx;

      ctx.save();
      ctx.strokeStyle = "rgba(231, 247, 255, 0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, yScale.top);
      ctx.lineTo(x, yScale.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(231, 247, 255, 0.78)";
      ctx.font = "11px IBM Plex Mono";
      ctx.fillText("Observed index", x + 6, yScale.top + 14);
      ctx.restore();
    },
  };

  const chart = new Chart(chartCanvas.getContext("2d"), {
    type: "line",
    data: {
      labels: allMonths,
      datasets: buildDatasets(),
    },
    options: {
      responsive: true,
      resizeDelay: 180,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#d7edf9",
            usePointStyle: true,
            pointStyle: "line",
          },
        },
        tooltip: {
          backgroundColor: "rgba(7, 19, 29, 0.95)",
          borderColor: "rgba(171, 222, 245, 0.32)",
          borderWidth: 1,
          callbacks: {
            title(items) {
              const ym = items[0].label;
              return fmtMonth(ym);
            },
            label(context) {
              if (context.parsed.y == null) {
                return `${context.dataset.label}: n/a`;
              }
              return `${context.dataset.label}: ${moneyPrecise.format(context.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#9dc4d6",
            maxTicksLimit: 10,
            callback(value) {
              const ym = this.getLabelForValue(value);
              return ym.endsWith("-01") ? ym.slice(0, 4) : "";
            },
          },
          grid: {
            color: "rgba(255, 255, 255, 0.05)",
          },
        },
        y: {
          ticks: {
            color: "#9dc4d6",
            callback(value) {
              return money.format(value);
            },
          },
          grid: {
            color: "rgba(255, 255, 255, 0.06)",
          },
        },
      },
    },
    plugins: [observedMarkerPlugin],
  });

  function applyVisibility() {
    chart.data.datasets.forEach((ds) => {
      const capacityOn = !!state.capacityEnabled[ds.capacity];
      const phaseOn =
        state.viewMode === "both" ||
        state.viewMode === ds.phase;
      ds.hidden = !(capacityOn && phaseOn);
    });
    chart.update();
  }

  function renderSummary() {
    summaryRows.innerHTML = "";

    capacities.forEach((cap) => {
      const key = `gb${cap}`;
      const launch = rootData.assumptions.launchMonthByCapacity[String(cap)] || rootData.assumptions.launchMonthByCapacity[cap];

      const latest = [...historical].reverse().find((r) => r[key] != null);
      const future = [...projection].reverse().find((r) => r[key] != null);

      const latestVal = latest ? latest[key] : null;
      const futureVal = future ? future[key] : null;
      const deltaPct = latestVal && futureVal ? ((futureVal - latestVal) / latestVal) * 100 : NaN;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${cap}GB</td>
        <td>${launch || "n/a"}</td>
        <td>${latestVal == null ? "n/a" : money.format(latestVal)}</td>
        <td>${futureVal == null ? "n/a" : money.format(futureVal)}</td>
        <td class="${deltaPct >= 0 ? "delta-up" : "delta-down"}">${fmtDelta(deltaPct)}</td>
      `;
      summaryRows.appendChild(tr);
    });
  }

  function renderSources() {
    sourceList.innerHTML = "";
    rootData.sources.forEach((src) => {
      const li = document.createElement("li");
      li.innerHTML = `<a href="${src.url}" target="_blank" rel="noopener noreferrer">${src.name}</a>`;
      sourceList.appendChild(li);
    });
  }

  function renderMeta() {
    const built = new Date(rootData.generatedAtUtc).toLocaleString("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    generatedMeta.textContent = `Built ${built} | Historical: ${rootData.historicalWindow.start} to ${rootData.historicalWindow.end} | Projection through ${rootData.projectionWindow.end}`;
  }

  function exportCsv() {
    const rows = historical.concat(projection);
    const header = ["month", "phase", "16GB_CAD", "32GB_CAD", "64GB_CAD"];
    const lines = [header.join(",")];

    rows.forEach((row) => {
      lines.push([
        row.month,
        row.phase,
        row.gb16 == null ? "" : row.gb16,
        row.gb32 == null ? "" : row.gb32,
        row.gb64 == null ? "" : row.gb64,
      ].join(","));
    });

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ddr5_desktop_module_prices_cad.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  document.querySelectorAll("input[data-capacity]").forEach((input) => {
    input.addEventListener("change", (ev) => {
      const cap = Number(ev.target.getAttribute("data-capacity"));
      state.capacityEnabled[cap] = ev.target.checked;
      applyVisibility();
    });
  });

  document.querySelectorAll("input[name='viewMode']").forEach((input) => {
    input.addEventListener("change", (ev) => {
      state.viewMode = ev.target.value;
      applyVisibility();
    });
  });

  exportButton.addEventListener("click", exportCsv);

  renderMeta();
  renderSummary();
  renderSources();
  applyVisibility();
})();
