import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute, { GuestRoute } from './components/ProtectedRoute';
import Library from './pages/Library';
import Login from './pages/Login';
import MovieDetail from './pages/MovieDetail';
import NotFound from './pages/NotFound';
import OAuthComplete from './pages/OAuthComplete';
import Profile from './pages/Profile';
import Register from './pages/Register';
import Settings from './pages/Settings';
import { ForgotPassword, ResetPassword } from './pages/PasswordReset';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
        </Route>

        <Route path="/oauth/complete" element={<OAuthComplete />} />

        <Route element={<ProtectedRoute />}>
          <Route index element={<Library />} />
          <Route path="/movies/:id" element={<MovieDetail />} />
          <Route path="/users/:id" element={<Profile />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
