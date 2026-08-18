import { Box, Group, Text, type BoxProps } from "@mantine/core";
import { WORKHORSE_VERSION } from "@workhorse/core/version";
const workhorseMarkUrl = new URL("./assets/workhorse-mark.svg", import.meta.url).href;
const workhorseWordmarkUrl = new URL("./assets/workhorse-wordmark.svg", import.meta.url).href;

interface WorkhorseMarkProps extends BoxProps {
  label?: string;
}

export function WorkhorseMark({ label = "Workhorse", ...props }: WorkhorseMarkProps) {
  return <Box component="img" src={workhorseMarkUrl} alt={label} {...props} />;
}

export function WorkhorseBrand() {
  return (
    <Group gap={6} wrap="nowrap" className="workhorse-brand">
      <Box className="workhorse-brand__mark" aria-hidden="true">
        <WorkhorseMark label="" w={38} h={38} />
      </Box>
      <Box
        component="img"
        src={workhorseWordmarkUrl}
        alt="Workhorse"
        className="workhorse-brand__wordmark"
      />
      <Text
        component="span"
        size="10px"
        c="dimmed"
        ff="monospace"
        aria-label={`Workhorse version ${WORKHORSE_VERSION}`}
        className="workhorse-brand__version"
      >
        v{WORKHORSE_VERSION}
      </Text>
    </Group>
  );
}
