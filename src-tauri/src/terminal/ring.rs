//! Ring buffer scrollback per-session (ADR-2, decision 0010).
//! Giữ tối đa `capacity` bytes cuối cùng của output để replay khi UI reattach.

pub struct RingBuffer {
    capacity: usize,
    data: Vec<u8>,
    /// Tổng số bytes đã bị đẩy ra khỏi buffer (phần đầu bị cắt).
    trimmed: u64,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self { capacity, data: Vec::new(), trimmed: 0 }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.capacity {
            // chunk một mình đã vượt capacity → chỉ giữ phần đuôi
            self.trimmed += (self.data.len() + bytes.len() - self.capacity) as u64;
            self.data.clear();
            self.data.extend_from_slice(&bytes[bytes.len() - self.capacity..]);
            return;
        }
        let overflow = (self.data.len() + bytes.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.data.drain(..overflow);
            self.trimmed += overflow as u64;
        }
        self.data.extend_from_slice(bytes);
    }

    pub fn contents(&self) -> &[u8] {
        &self.data
    }

    #[allow(dead_code)]
    pub fn trimmed(&self) -> u64 {
        self.trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_all_under_capacity() {
        let mut rb = RingBuffer::new(10);
        rb.push(b"hello");
        rb.push(b"world");
        assert_eq!(rb.contents(), b"helloworld");
        assert_eq!(rb.trimmed(), 0);
    }

    #[test]
    fn trims_oldest_on_overflow() {
        let mut rb = RingBuffer::new(8);
        rb.push(b"abcdef");
        rb.push(b"ghij"); // 10 bytes tổng → cắt "ab"
        assert_eq!(rb.contents(), b"cdefghij");
        assert_eq!(rb.trimmed(), 2);
    }

    #[test]
    fn giant_chunk_keeps_tail() {
        let mut rb = RingBuffer::new(4);
        rb.push(b"0123456789");
        assert_eq!(rb.contents(), b"6789");
        assert_eq!(rb.trimmed(), 6);
    }
}
