import http from 'k6/http';
import { check, sleep } from 'k6';

const baseURL = __ENV.OPENJORNADA_BASE_URL;
if (!baseURL) throw new Error('Define OPENJORNADA_BASE_URL');

export const options = {
  scenarios: {
    concurrent_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '3m', target: 500 },
        { duration: '10m', target: 500 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750', 'p(99)<1500'],
  },
};

export default function () {
  const health = http.get(`${baseURL}/api/health`, { tags: { endpoint: 'health' } });
  check(health, { 'health 200': (response) => response.status === 200 });
  const plans = http.get(`${baseURL}/api/openjornada/public/plans`, {
    tags: { endpoint: 'plans' },
  });
  check(plans, { 'plans 200 o desactivado': (response) => [200, 404].includes(response.status) });
  sleep(1);
}
