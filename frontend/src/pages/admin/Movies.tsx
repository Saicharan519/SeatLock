import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Poster } from '../../components/Poster';
import { ButtonLink, Certificate, Notice, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDuration, formatWhen } from '../../lib/format';
import { useLoad, useTitle } from '../../lib/hooks';
import { Input, PageHeader, Panel, Table, td } from './kit';

export function Movies() {
  useTitle('Movies · Admin');
  const saved = (useLocation().state as { saved?: string } | null)?.saved;
  const [q, setQ] = useState('');
  const { data, error, loading } = useLoad(() => api.movies({}), []);
  const movies = (data?.movies ?? []).filter((m) =>
    m.title.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <PageHeader title="Movies" action={<ButtonLink to="/admin/movies/new">Add movie</ButtonLink>}>
        The catalogue customers browse. Schedule a movie from Showtimes once it’s here.
      </PageHeader>
      {saved && (
        <Notice tone="success" className="mb-4">
          Saved “{saved}”.
        </Notice>
      )}
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter by title"
        aria-label="Filter movies"
        className="mb-4 sm:max-w-xs"
      />
      <Panel>
        {error && <Notice tone="error">{error}</Notice>}
        {loading && <Skeleton className="h-64" />}
        {data && (
          <Table head={['', 'Title', 'Details', 'Upcoming shows', '']}>
            {movies.map((m) => (
              <tr key={m.id}>
                <td className={`${td} w-12`}>
                  <Poster url={m.posterUrl} title={m.title} size="w185" className="w-9 !rounded" />
                </td>
                <td className={td}>
                  <Link to={`/movies/${m.slug}`} className="font-semibold hover:text-marigold-hi">
                    {m.title}
                  </Link>
                  <div className="font-mono text-xs text-faint">/{m.slug}</div>
                </td>
                <td className={`${td} text-xs text-dim`}>
                  <div className="flex items-center gap-2">
                    <Certificate value={m.certificate} />
                    {m.language} · {formatDuration(m.durationMinutes)}
                  </div>
                  <div className="mt-0.5 text-faint">{m.genres.join(', ') || 'No genres'}</div>
                </td>
                <td className={`${td} text-xs`}>
                  {m.showCount > 0 ? (
                    <>
                      {m.showCount}
                      <div className="text-faint">next {formatWhen(m.nextShowAt!)}</div>
                    </>
                  ) : (
                    <span className="text-faint">None scheduled</span>
                  )}
                </td>
                <td className={`${td} text-right`}>
                  <Link
                    to={`/admin/movies/${m.id}`}
                    className="text-sm font-semibold text-marigold-hi hover:underline"
                  >
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
