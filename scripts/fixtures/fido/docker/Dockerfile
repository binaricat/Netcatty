FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/sh netcatty && passwd -d netcatty \
    && mkdir -p /run/sshd /fixtures && rm -f /etc/ssh/ssh_host_*
COPY sshd_config /etc/ssh/sshd_config
EXPOSE 2222
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
