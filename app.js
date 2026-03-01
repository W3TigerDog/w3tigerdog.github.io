const coins = [
  "bitcoin",
  "ethereum",
  "solana",
  "binancecoin"
];

async function loadPrices() {
  const ids = coins.join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  const res = await fetch(url);
  const data = await res.json();

  const body = document.getElementById("priceBody");
  body.innerHTML = "";

  coins.forEach(id => {
    const row = data[id];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${id.toUpperCase()}</td>
      <td>$${row.usd}</td>
      <td>${row.usd_24h_change.toFixed(2)}%</td>
    `;
    body.appendChild(tr);
  });
}

function loadTime() {
  const zones = [
    "America/New_York",
    "Europe/London",
    "Asia/Shanghai",
    "Asia/Tokyo"
  ];

  const container = document.getElementById("timeList");
  container.innerHTML = "";

  zones.forEach(z => {
    const div = document.createElement("div");
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: z,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());

    div.innerHTML = `<strong>${z}</strong> — ${time}`;
    container.appendChild(div);
  });
}

loadPrices();
setInterval(loadPrices, 15000);
setInterval(loadTime, 1000);
loadTime();