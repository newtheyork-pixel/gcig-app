import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import TerminalShell from '../terminal/TerminalShell.jsx';
import '../terminal/theme.css';

// Terminal page. Open to Analyst and above, plus the Advisory Board /
// Faculty Advisor.
//
// It was executive-only until the FLD field-research panel landed, which
// made the gate actively wrong: /api/research lets Analyst-and-above do
// the fieldwork, so the members most likely to be making the calls were
// the ones who could not open the surface built for them. The gate now
// mirrors that API rank exactly.
//
// JuniorAnalyst stays out on purpose — it ranks below Analyst on the
// server and is the default role for every Google self-signup.
// Renders full-bleed by hiding the standard app chrome via the
// `data-theme="terminal"` wrapper.

export default function Terminal() {
  const { user, isAnalystOrAbove, isAdvisory } = useAuth();
  const navigate = useNavigate();

  // Hide page scroll while terminal is mounted (we own the whole viewport).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!user) return <Navigate to="/login" replace />;
  if (!isAnalystOrAbove && !isAdvisory) return <Navigate to="/dashboard" replace />;

  return <TerminalShell onExit={() => navigate('/dashboard')} />;
}
