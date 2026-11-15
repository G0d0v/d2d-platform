import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './github.css';
import './refinement.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
