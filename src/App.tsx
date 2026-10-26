import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useStore } from './store';
import BoreholeList from './pages/BoreholeList';
import BoreholeForm from './pages/BoreholeForm';
import BoreholeDetail from './pages/BoreholeDetail';
import ReadingForm from './pages/ReadingForm';
import ReadingsList from './pages/ReadingsList';
import SettingsPage from './pages/SettingsPage';
import InstallTip from './InstallTip';
import UpdateBanner from './UpdateBanner';
import { SyncBadge } from './sync/useSync';

export default function App() {
  const { ready, loadError } = useStore();
  const loc = useLocation();
  return (
    <div className="app">
      <header className="top"><h1>Water Level Log</h1><SyncBadge /></header>
      <UpdateBanner />
      <InstallTip />
      <main>
        {loadError ? <p className="error" role="alert">Could not open the on-device database: {loadError}. Close and reopen the app.</p> : !ready ? <p>Loading…</p> : (
          // Keyed by URL so forms reset when moving between edit and new.
          <Routes key={loc.pathname + loc.search}>
            <Route path="/" element={<BoreholeList />} />
            <Route path="/new-borehole" element={<BoreholeForm />} />
            <Route path="/borehole/:name" element={<BoreholeDetail />} />
            <Route path="/borehole/:name/edit" element={<BoreholeForm />} />
            <Route path="/reading/new" element={<ReadingForm />} />
            <Route path="/reading/:id" element={<ReadingForm />} />
            <Route path="/readings" element={<ReadingsList />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<BoreholeList />} />
          </Routes>
        )}
      </main>
      <nav className="tabs">
        <NavLink to="/" end>Boreholes</NavLink>
        <NavLink to="/reading/new" data-testid="tab-add">+ Reading</NavLink>
        <NavLink to="/readings">Readings</NavLink>
        <NavLink to="/settings" data-testid="tab-settings">Settings</NavLink>
      </nav>
    </div>
  );
}
