export function smsPriceOptionKey(option) {
  return `${option.country}|${option.price}|${option.providerIds || ""}`;
}

export function findSmsNumberOption(options, config = {}) {
  const country = String(config.country ?? "");
  const price = Number(config.maxPrice);
  const providerIds = String(config.providerIds || "");
  return options.find((option) => (
    option.country === country
    && Number(option.price) === price
    && (!providerIds || option.providerIds === providerIds)
  )) || options.find((option) => option.country === country && Number(option.price) === price)
    || options.find((option) => option.country === country)
    || null;
}

export function groupSmsCountries(options, countryName = (option) => option.title || `国家 ${option.country}`) {
  const countries = new Map();
  for (const option of options) {
    let country = countries.get(option.country);
    if (!country) {
      const rate = option.successRate;
      country = {
        country: option.country,
        title: countryName(option),
        successRate: typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : null,
        tiers: [],
      };
      countries.set(option.country, country);
    }
    country.tiers.push(option);
  }
  for (const country of countries.values()) {
    country.tiers.sort((a, b) => Number(a.price) - Number(b.price) || Number(b.count) - Number(a.count));
    country.minPrice = Number(country.tiers[0].price);
  }
  return [...countries.values()];
}

export function filterSmsCountries(countries, { search = "", quality = "all", sort = "quality" } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return countries.filter((country) => {
    if (query && !`${country.title} ${country.country}`.toLocaleLowerCase().includes(query)) return false;
    const rate = country.successRate;
    if (quality === "high") return rate !== null && rate >= 90;
    if (quality === "medium") return rate !== null && rate >= 70 && rate < 90;
    if (quality === "low") return rate !== null && rate < 70;
    if (quality === "unknown") return rate === null;
    return true;
  }).sort((a, b) => {
    if (sort === "quality") {
      if (a.successRate === null && b.successRate !== null) return 1;
      if (a.successRate !== null && b.successRate === null) return -1;
      if (a.successRate !== b.successRate) return (b.successRate ?? -1) - (a.successRate ?? -1);
    }
    return a.minPrice - b.minPrice || a.title.localeCompare(b.title, "zh-CN");
  });
}

export function preferredSmsNumberOption(options, providerId) {
  const countries = groupSmsCountries(options);
  return filterSmsCountries(countries, { sort: providerId === "herosms" ? "quality" : "price" })[0]?.tiers[0] || null;
}

export function formatSmsSuccessRate(rate) {
  return rate === null ? "暂无数据" : `${Number(rate.toFixed(1))}%`;
}
