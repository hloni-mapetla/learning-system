import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { SourcesPage } from './pages/Sources';
import { SourceDetailPage } from './pages/SourceDetail';
import { NotesPage } from './pages/Notes';
import { NoteDetailPage } from './pages/NoteDetail';
import { SearchPage } from './pages/Search';
import { ReviewPage } from './pages/Review';
import { CardsPage } from './pages/Cards';
import { TodayPage } from './pages/Today';
import { ImportPage } from './pages/Import';

const root = createRootRoute({
  component: Layout,
  notFoundComponent: () => <div className="text-muted">Not found.</div>,
});
const r = (path: string, component: () => React.ReactNode) => createRoute({ getParentRoute: () => root, path, component });

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: '/', beforeLoad: () => { throw redirect({ to: '/today' }); } }),
  r('/today', TodayPage),
  r('/graph', lazyRouteComponent(() => import('./pages/Graph'), 'GraphPage') as any),
  r('/stats', lazyRouteComponent(() => import('./pages/Stats'), 'StatsPage') as any),
  r('/import', ImportPage),
  r('/sources', SourcesPage),
  r('/sources/$id', SourceDetailPage),
  r('/notes', NotesPage),
  r('/notes/$id', NoteDetailPage),
  r('/search', SearchPage),
  r('/review', ReviewPage),
  r('/cards', CardsPage),
]);

export const router = createRouter({ routeTree, defaultPreload: false });
