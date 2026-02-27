import { config } from "../config.js";

export async function getWeather(city: string): Promise<string> {
  if (!config.OPENWEATHER_API_KEY) {
    return "Weather integration not configured. Set OPENWEATHER_API_KEY in .env";
  }

  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=${config.OPENWEATHER_API_KEY}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    name: string;
    main: { temp: number; humidity: number };
    weather: { description: string }[];
    wind: { speed: number };
  };

  return [
    `*${data.name}*`,
    `${data.weather[0]?.description ?? "unknown"} | ${data.main.temp}°C`,
    `Humidity: ${data.main.humidity}% | Wind: ${data.wind.speed} m/s`,
  ].join("\n");
}
