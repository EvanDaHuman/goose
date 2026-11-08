// Waits caused only by missing execution infrastructure (not a decision anyone has to make). The worker resumes these
// automatically once the backend is available (lib/infraRecovery.ts), and customer pages describe them that way.
export const DOCKER_WAIT = "Start the Docker Linux execution backend before autonomous discovery.";
export const isInfraWait = (reason: string | null | undefined) => !!reason && reason.startsWith(DOCKER_WAIT);
