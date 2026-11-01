import { app } from './app';
import { validateSecurityConfig } from './services/securityConfig';

validateSecurityConfig();

const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
