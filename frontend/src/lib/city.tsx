import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

interface CityState {
  city: string;
  cities: { city: string; theatres: number }[];
  setCity: (city: string) => void;
}

const KEY = 'seatlock.city';
const DEFAULT_CITY = 'Hyderabad';
const CityContext = createContext<CityState | null>(null);

/** The city the visitor browses in, remembered across visits, like any ticketing site. */
export function CityProvider({ children }: { children: ReactNode }) {
  const [city, setCityState] = useState(() => localStorage.getItem(KEY) ?? DEFAULT_CITY);
  const [cities, setCities] = useState<CityState['cities']>([]);

  useEffect(() => {
    api
      .cities()
      .then(({ cities }) => {
        setCities(cities);
        // A remembered city with no shows any more falls back to the first one that has them
        if (cities.length && !cities.some((c) => c.city === city)) {
          setCityState(cities.find((c) => c.city === DEFAULT_CITY)?.city ?? cities[0]!.city);
        }
      })
      .catch(() => undefined);
    // Only on first load; later changes come from the picker
  }, []);

  const setCity = (c: string) => {
    localStorage.setItem(KEY, c);
    setCityState(c);
  };

  return <CityContext.Provider value={{ city, cities, setCity }}>{children}</CityContext.Provider>;
}

export function useCity(): CityState {
  const ctx = useContext(CityContext);
  if (!ctx) throw new Error('useCity outside CityProvider');
  return ctx;
}
