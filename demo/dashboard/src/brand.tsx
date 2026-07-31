import { Box, Group, type BoxProps } from "@mantine/core";

interface WorkhorseMarkProps extends BoxProps {
  label?: string;
}

export function WorkhorseMark({ label = "Workhorse", ...props }: WorkhorseMarkProps) {
  return <Box component="img" src="/brand/workhorse-mark.png" alt={label} {...props} />;
}

export function WorkhorseBrand() {
  return (
    <Group gap={10} wrap="nowrap" className="workhorse-brand">
      <Box className="workhorse-brand__mark" aria-hidden="true">
        <WorkhorseMark label="" w={34} h={34} />
      </Box>
      <Box
        component="img"
        src="/brand/workhorse-wordmark.png"
        alt="Workhorse"
        className="workhorse-brand__wordmark"
      />
    </Group>
  );
}
